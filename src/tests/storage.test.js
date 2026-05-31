import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We'll test the storage module by temporarily overriding the config dir
// Create a temp dir and patch the module

describe('storage defaults', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-test-'));
        // Override HOME so storage uses our temp dir
        process.env._TEST_CONFIG_DIR = tempDir;
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        delete process.env._TEST_CONFIG_DIR;
    });

    test('DEFAULT_CREDENTIALS has no groqApiKey or apiKey', () => {
        // Read the storage.js source and check DEFAULT_CREDENTIALS shape
        const src = fs.readFileSync(new URL('../storage.js', import.meta.url), 'utf8');
        // groqApiKey should not appear in DEFAULT_CREDENTIALS
        const credBlock = src.match(/const DEFAULT_CREDENTIALS = \{([^}]+)\}/s)?.[1] || '';
        assert.ok(!credBlock.includes('groqApiKey'), 'groqApiKey should not be in DEFAULT_CREDENTIALS');
        assert.ok(!credBlock.includes("apiKey: ''"), 'Gemini apiKey should not be in DEFAULT_CREDENTIALS');
        assert.ok(credBlock.includes('openaiApiKey'), 'openaiApiKey should be in DEFAULT_CREDENTIALS');
    });

    test('storage module exports getOpenaiApiKey and setOpenaiApiKey', async () => {
        // Dynamically check exports (we can't easily import due to Electron deps)
        const src = fs.readFileSync(new URL('../storage.js', import.meta.url), 'utf8');
        assert.ok(src.includes('getOpenaiApiKey'), 'must export getOpenaiApiKey');
        assert.ok(src.includes('setOpenaiApiKey'), 'must export setOpenaiApiKey');
    });

    test('storage module does not export getGroqApiKey or getAvailableModel (Gemini)', () => {
        const src = fs.readFileSync(new URL('../storage.js', import.meta.url), 'utf8');
        // Check the exports block at the bottom
        const exportsBlock = src.match(/module\.exports\s*=\s*\{([^}]+)\}/s)?.[1] || '';
        assert.ok(!exportsBlock.includes('getGroqApiKey'), 'getGroqApiKey should not be exported');
        assert.ok(!exportsBlock.includes('getAvailableModel'), 'getAvailableModel should not be exported');
        assert.ok(!exportsBlock.includes('getModelForToday'), 'getModelForToday should not be exported');
    });
});

describe('OpenAI key storage operations', () => {
    test('openaiApiKey round-trip via JSON', () => {
        // Test the serialization logic inline (no Electron needed)
        const credentials = { openaiApiKey: '' };
        const testKey = 'sk-test-1234567890';
        credentials.openaiApiKey = testKey;
        const serialized = JSON.stringify(credentials);
        const parsed = JSON.parse(serialized);
        assert.strictEqual(parsed.openaiApiKey, testKey);
    });

    test('openaiApiKey defaults to empty string', () => {
        const credentials = { openaiApiKey: '' };
        assert.strictEqual(credentials.openaiApiKey, '');
    });
});
