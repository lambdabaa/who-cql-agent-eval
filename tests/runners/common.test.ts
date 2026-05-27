import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePrompt, parseFencedOutputs, writeOutputs } from '../../src/runners/common.js';
import type { AuthoringTaskSpec } from '../../src/agent_tasks/schema.js';

const TASK: AuthoringTaskSpec = {
  id: 'unit',
  kind: 'authoring',
  dak: 'smart-immunizations',
  logicLibraryId: 'TestLogic',
  outputFiles: ['TestLogic.cql'],
};

describe('composePrompt', () => {
  it('inlines prompt and every inputs/ file with relative paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-'));
    writeFileSync(join(dir, 'prompt.md'), '# Hello\nWrite a CQL library.');
    mkdirSync(join(dir, 'inputs'), { recursive: true });
    writeFileSync(join(dir, 'inputs', 'L2.md'), 'row 1\nrow 2');
    mkdirSync(join(dir, 'inputs', 'deps'), { recursive: true });
    writeFileSync(join(dir, 'inputs', 'deps', 'Other.cql'), 'library Other');

    const { system, user } = composePrompt(dir, TASK);
    expect(system).toContain('path=<relative-path>');
    expect(user).toContain('# Hello');
    expect(user).toContain('## OUTPUT FILES');
    expect(user).toContain('`TestLogic.cql`');
    expect(user).toContain('inputs/L2.md');
    expect(user).toContain('row 1');
    expect(user).toContain('inputs/deps/Other.cql');
    expect(user).toContain('library Other');
  });
});

describe('parseFencedOutputs', () => {
  it('extracts files emitted with path=... info string', () => {
    const resp = [
      'Here is the library:',
      '```cql path=TestLogic.cql',
      'library TestLogic',
      'define "X": true',
      '```',
      'And the predictions:',
      '```json path=predictions.json',
      '{"a": 1}',
      '```',
    ].join('\n');
    const got = parseFencedOutputs(resp);
    expect(Object.keys(got).sort()).toEqual(['TestLogic.cql', 'predictions.json']);
    expect(got['TestLogic.cql']).toContain('library TestLogic');
    expect(got['predictions.json']).toBe('{"a": 1}');
  });

  it('accepts path=... as the entire info string', () => {
    const resp = '```path=foo.txt\nhi\n```';
    expect(parseFencedOutputs(resp)).toEqual({ 'foo.txt': 'hi' });
  });

  it('ignores fences without a path= tag', () => {
    const resp = '```cql\nlibrary X\n```\n```path=keep.cql\nlibrary K\n```';
    expect(parseFencedOutputs(resp)).toEqual({ 'keep.cql': 'library K' });
  });
});

describe('writeOutputs', () => {
  it('writes each captured file under outputs/ and reports missing expected outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-out-'));
    const { written, missing } = writeOutputs(
      dir,
      { 'TestLogic.cql': 'library TestLogic' },
      ['TestLogic.cql', 'README.md'],
    );
    expect(written).toEqual(['TestLogic.cql']);
    expect(missing).toEqual(['README.md']);
    expect(readFileSync(join(dir, 'outputs', 'TestLogic.cql'), 'utf8')).toBe('library TestLogic');
  });
});
