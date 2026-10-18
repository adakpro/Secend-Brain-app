import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structuredSchema } from '../src/structured.mjs';
test('Codex schema closes nested objects without mutating the report schema', () => {
  const report = { type: 'object', properties: { citations: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } } } };
  const schema = structuredSchema(report);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.structured.properties.citations.items.additionalProperties, false);
  assert.deepEqual(schema.properties.proposals.items.required, ['op', 'path', 'content', 'rationale', 'sourceRefs']);
  assert.equal(report.additionalProperties, undefined);
});
