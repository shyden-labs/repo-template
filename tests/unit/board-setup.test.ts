import { describe, it, expect } from 'vitest';
import { planEstimateField } from '../../scripts/board-setup';

/**
 * Every project board carries a Number field named `Estimate`, so progress
 * can be counted in story points as well as tickets (docs/project-board.md).
 */

describe('planEstimateField', () => {
  it('creates the field on a board that has none', () => {
    expect(
      planEstimateField([
        { name: 'Title', dataType: 'TITLE' },
        { name: 'Status', dataType: 'SINGLE_SELECT' },
      ]),
    ).toBe('create');
  });

  it('keeps a Number field already named Estimate', () => {
    expect(planEstimateField([{ name: 'Estimate', dataType: 'NUMBER' }])).toBe(
      'exists',
    );
  });

  it('refuses an Estimate field of another type by name', () => {
    expect(() =>
      planEstimateField([{ name: 'Estimate', dataType: 'TEXT' }]),
    ).toThrow(
      'the board has an "Estimate" field of type TEXT; it must be NUMBER: rename or delete it first',
    );
  });
});
