import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCampaign, readDrafts, surfaces } from './campaign';
const valid = { business: 'Test business', listing: 'https://maps.google.com/?cid=123', location: 'Miami Beach', keywords: ['lawyer near me'], days: 45, warmup: 14, devices: 5, concurrency: 3, surfaces: [surfaces[0]] };
test('campaign reserves at least one tracking day', () => { assert.deepEqual(validateCampaign(valid), []); assert.ok(validateCampaign({...valid, days: 14}).length); });
test('capacity and surface validation rejects impossible schedules', () => { assert.ok(validateCampaign({...valid, concurrency: 6}).length); assert.ok(validateCampaign({...valid, surfaces: ['unknown']}).length); assert.ok(validateCampaign({...valid, devices: 1.5}).length); });
test('corrupted browser storage cannot become a campaign', () => { for (const raw of ['{', '{}', '[null]', '[{"status":"draft"}]']) assert.deepEqual(readDrafts(raw), []); assert.equal(readDrafts(JSON.stringify([{...valid, status:'draft', id:'test', createdAt:new Date().toISOString()}])).length, 1); });
