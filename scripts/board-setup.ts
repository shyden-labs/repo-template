/**
 * Gives a project board the Number field `Estimate` that progress by effort
 * reads (docs/project-board.md). Run once per board:
 *
 *   node scripts/board-setup.ts <board-node-id> "<board title>"
 *
 * It reads the board by node id, refuses a board whose title differs, creates
 * the field only if it is missing, and reads it back.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertTitle } from './board-progress.ts';

interface Field {
  name: string;
  dataType: string;
}

/** What the board needs: the field created, or nothing. */
export function planEstimateField(fields: Field[]): 'create' | 'exists' {
  const found = fields.find((f) => f.name === 'Estimate');
  if (found === undefined) return 'create';
  if (found.dataType !== 'NUMBER') {
    throw new Error(
      `the board has an "Estimate" field of type ${found.dataType}; it must be NUMBER: rename or delete it first`,
    );
  }
  return 'exists';
}

function gql(query: string, vars: Record<string, string>): unknown {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`);
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

interface Board {
  data: { node: { title: string; fields: { nodes: Field[] } } };
}

const READ = `query($id: ID!) { node(id: $id) { ... on ProjectV2 { title
  fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name dataType } } } } } }`;

function main(): void {
  const [id, title] = process.argv.slice(2);
  if (id === undefined || title === undefined) {
    throw new Error('usage: node scripts/board-setup.ts <board-node-id> "<board title>"');
  }
  const read = (): Board => gql(READ, { id }) as Board;
  const before = read().data.node;
  assertTitle(before.title, title);
  if (planEstimateField(before.fields.nodes) === 'create') {
    gql(
      `mutation($id: ID!) { createProjectV2Field(input: { projectId: $id, dataType: NUMBER, name: "Estimate" }) { clientMutationId } }`,
      { id },
    );
  }
  const after = read().data.node;
  if (planEstimateField(after.fields.nodes) !== 'exists') {
    throw new Error('the Estimate field was not there on reading back');
  }
  process.stdout.write(`"${after.title}" has a Number field "Estimate".\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
