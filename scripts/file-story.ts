/**
 * Files one story the way every project does (issue #20; Shyden 2026-10-16:
 * "the whole procedure"; docs/project-board.md, "Filing a ticket"):
 *
 *   node scripts/file-story.ts <board-node-id> "<board title>" <story.json>
 *
 * story.json: { "repo": "owner/name", "title", "body", "estimate", "priority",
 * "status"? (Todo), "blockedBy"? ([]), "parent"? (null) }.
 *
 * Before anything is written it checks the story (an Estimate on the scale, a
 * Priority P0 to P5, the form's five sections, no closing keyword), resolves
 * the board by node id and asserts its title, finds its fields, and refuses a
 * title already open. Then it files the issue, adds it to the board, sets
 * Estimate, Priority and Status, adds each Blocked-by link and the parent,
 * and reads every one back, failing by name on any that did not take.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertTitle } from './board-progress.ts';
import { runIfEntry } from './cli.ts';

export interface Story {
  repo: string;
  title: string;
  body: string;
  estimate: number;
  priority: string;
  status: string;
  blockedBy: number[];
  parent: number | null;
}

interface Field {
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string }[];
}

const ESTIMATES = [1, 2, 3, 5, 8, 13];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
const SECTIONS = ['Story', 'Context', 'Acceptance criteria', 'Announce', 'Definition of done'];
/** GitHub closes an issue when one of these stands right before its number, even negated. */
const CLOSING = /\b((?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+))/i;

const fail = (message: string): never => {
  throw new Error(`file-story: ${message}`);
};

const isNumber = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** The story file, checked before anything is written. */
export function parseStory(text: string): Story {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('the story is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('the story is not a JSON object');
  const s = raw as Record<string, unknown>;
  if (typeof s.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(s.repo)) fail('repo must be <owner>/<name>');
  if (typeof s.title !== 'string' || s.title.trim() === '') fail('the title is empty');
  if (!ESTIMATES.includes(s.estimate as number)) {
    fail(`estimate ${String(s.estimate)} is not 1, 2, 3, 5, 8 or 13 (larger is an epic: split it)`);
  }
  if (!PRIORITIES.includes(s.priority as string)) fail(`priority ${String(s.priority)} is not P0 to P5`);
  const status = s.status ?? 'Todo';
  if (typeof status !== 'string') fail('status must be the name of a Status option');
  const blockedBy = s.blockedBy ?? [];
  if (!Array.isArray(blockedBy) || !blockedBy.every(isNumber)) fail('blockedBy must list issue numbers');
  const parent = s.parent ?? null;
  if (parent !== null && !isNumber(parent)) fail('parent must be an issue number');
  const body = String(s.body ?? '');
  for (const section of SECTIONS) {
    if (!body.includes(`## ${section}`)) fail(`the body has no "## ${section}" section`);
  }
  const closing = CLOSING.exec(body);
  if (closing !== null) fail(`the body would close #${closing[2]} on merge ("${closing[1]}"); write "Refs #${closing[2]}"`);
  return {
    repo: s.repo as string,
    title: s.title as string,
    body,
    estimate: s.estimate as number,
    priority: s.priority as string,
    status: status as string,
    blockedBy: blockedBy as number[],
    parent: parent as number | null,
  };
}

const option = (field: Field, name: string) => field.options?.find((o) => o.name === name);

/** The board's Estimate, Priority and Status fields, and the options this story sets. */
export function boardFields(fields: Field[], story: Story) {
  const named = (name: string, dataType: string) => fields.find((f) => f.name === name && f.dataType === dataType);
  const estimate = named('Estimate', 'NUMBER') ?? fail('the board has no Number field "Estimate"; run scripts/board-setup.ts');
  const priority =
    named('Priority', 'SINGLE_SELECT') ?? fail('the board has no single-select field "Priority"; run scripts/board-setup.ts');
  const status = named('Status', 'SINGLE_SELECT') ?? fail('the board has no single-select field "Status"');
  const statusOption =
    option(status, story.status) ??
    fail(`the board's Status has no option "${story.status}" (it has ${(status.options ?? []).map((o) => o.name).join(', ')})`);
  return {
    estimate: estimate.id,
    priority: { field: priority.id, option: (option(priority, story.priority) as { id: string }).id },
    status: { field: status.id, option: statusOption.id },
  };
}

const gh = (args: string[]): unknown => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));

const READ_BOARD = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { title
  fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name } } } } } } }`;
const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`;
const SET_NUMBER = `mutation($project: ID!, $item: ID!, $field: ID!, $number: Float!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { number: $number } }) { clientMutationId } }`;
const SET_OPTION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { clientMutationId } }`;
const READ_ITEM = `query($item: ID!) { node(id: $item) { ... on ProjectV2Item { project { title }
  estimate: fieldValueByName(name: "Estimate") { ... on ProjectV2ItemFieldNumberValue { number } }
  priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } }`;

const list = (numbers: number[]) => (numbers.length === 0 ? 'nothing' : numbers.map((n) => `#${n}`).join(', '));

export function main(args: string[]): number {
  const [id, title, file, ...rest] = args;
  if (id === undefined || title === undefined || file === undefined || rest.length > 0) {
    throw new Error('usage: node scripts/file-story.ts <board-node-id> "<board title>" <story.json>');
  }
  const story = parseStory(readFileSync(file, 'utf8'));
  const board = (gh(['api', 'graphql', '-f', `query=${READ_BOARD}`, '-f', `id=${id}`]) as {
    data: { node: { title: string; fields: { nodes: Field[] } } };
  }).data.node;
  assertTitle(board.title, title);
  const fields = boardFields(board.fields.nodes, story);
  const open = gh([
    'issue', 'list', '-R', story.repo, '--state', 'open', '--search', `${story.title} in:title`, '--limit', '100', '--json', 'number,title',
  ]) as { number: number; title: string }[];
  const same = open.find((i) => i.title.trim().toLowerCase() === story.title.trim().toLowerCase());
  if (same !== undefined) fail(`#${same.number} "${same.title}" is already open; add to it instead`);

  const issue = gh(['api', '-X', 'POST', `repos/${story.repo}/issues`, '-f', `title=${story.title}`, '-f', `body=${story.body}`]) as {
    number: number;
    id: number;
    node_id: string;
  };
  const ref = `${story.repo}#${issue.number}`;
  process.stdout.write(`file-story: filed ${ref} "${story.title}"\n`);
  const item = (gh(['api', 'graphql', '-f', `query=${ADD}`, '-f', `project=${id}`, '-f', `content=${issue.node_id}`]) as {
    data: { addProjectV2ItemById: { item: { id: string } } };
  }).data.addProjectV2ItemById.item.id;
  const on = ['-f', `project=${id}`, '-f', `item=${item}`];
  gh(['api', 'graphql', '-f', `query=${SET_NUMBER}`, ...on, '-f', `field=${fields.estimate}`, '-F', `number=${story.estimate}`]);
  for (const f of [fields.priority, fields.status]) {
    gh(['api', 'graphql', '-f', `query=${SET_OPTION}`, ...on, '-f', `field=${f.field}`, '-f', `option=${f.option}`]);
  }
  for (const blocker of story.blockedBy) {
    const blockerId = (gh(['api', `repos/${story.repo}/issues/${blocker}`]) as { id: number }).id;
    gh(['api', '-X', 'POST', `repos/${story.repo}/issues/${issue.number}/dependencies/blocked_by`, '-F', `issue_id=${blockerId}`]);
  }
  if (story.parent !== null) {
    gh(['api', '-X', 'POST', `repos/${story.repo}/issues/${story.parent}/sub_issues`, '-F', `sub_issue_id=${issue.id}`]);
  }

  const back = (gh(['api', 'graphql', '-f', `query=${READ_ITEM}`, '-f', `item=${item}`]) as {
    data: {
      node: {
        project: { title: string };
        estimate: { number: number } | null;
        priority: { name: string } | null;
        status: { name: string } | null;
      };
    };
  }).data.node;
  const blockers = (gh(['api', `repos/${story.repo}/issues/${issue.number}/dependencies/blocked_by`]) as { number: number }[])
    .map((b) => b.number)
    .sort((a, b) => a - b);
  const parent =
    story.parent === null ? null : (gh(['api', `repos/${story.repo}/issues/${issue.number}/parent`]) as { number: number }).number;
  const problems = [
    back.project.title === title ? '' : `the item read back on ${back.project.title}, not ${title}`,
    back.estimate?.number === story.estimate ? '' : `Estimate read back as ${back.estimate?.number ?? 'none'}, not ${story.estimate}`,
    back.priority?.name === story.priority ? '' : `Priority read back as ${back.priority?.name ?? 'none'}, not ${story.priority}`,
    back.status?.name === story.status ? '' : `Status read back as ${back.status?.name ?? 'none'}, not ${story.status}`,
    list(blockers) === list([...story.blockedBy].sort((a, b) => a - b))
      ? ''
      : `blocked by read back as ${list(blockers)}, not ${list(story.blockedBy)}`,
    parent === story.parent ? '' : `parent read back as #${parent}, not #${story.parent}`,
  ].filter((p) => p !== '');
  if (problems.length > 0) fail(`${ref} was filed, but ${problems.join('; ')}`);
  process.stdout.write(
    `file-story: read back: board ${back.project.title}, Estimate ${story.estimate}, Priority ${story.priority}, ` +
      `Status ${story.status}, blocked by ${list(blockers)}, parent ${parent === null ? 'none' : `#${parent}`}\n`,
  );
  return 0;
}

runIfEntry(import.meta.url, main);
