import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Pure functions copied/inlined for isolation ──

function calculateRMS(pcmBuffer) {
    const samples = pcmBuffer.length / 2;
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const s = pcmBuffer.readInt16LE(i * 2) / 32768;
        sum += s * s;
    }
    return Math.sqrt(sum / samples);
}

// VAD state factory
function createVadState() {
    return { isSpeaking: false, speechBuffers: [], silenceFrameCount: 0, speechFrameCount: 0 };
}
const WHISPER_VAD = { energyThreshold: 0.008, speechFramesRequired: 3, silenceFramesRequired: 30 };

// Inline VAD logic (mirrors gemini.js processWhisperVAD but returns state + action)
function processVAD(state, pcmBuffer) {
    const rms = calculateRMS(pcmBuffer);
    const isVoice = rms > WHISPER_VAD.energyThreshold;
    let action = null;
    if (isVoice) {
        state.speechFrameCount++;
        state.silenceFrameCount = 0;
        if (!state.isSpeaking && state.speechFrameCount >= WHISPER_VAD.speechFramesRequired) {
            state.isSpeaking = true;
            state.speechBuffers = [];
        }
    } else {
        state.silenceFrameCount++;
        state.speechFrameCount = 0;
        if (state.isSpeaking && state.silenceFrameCount >= WHISPER_VAD.silenceFramesRequired) {
            state.isSpeaking = false;
            const audioData = Buffer.concat(state.speechBuffers);
            state.speechBuffers = [];
            if (audioData.length >= 24000) {
                action = { type: 'transcribe', audio: audioData };
            }
            return { state, action };
        }
    }
    if (state.isSpeaking) {
        state.speechBuffers.push(Buffer.from(pcmBuffer));
    }
    return { state, action };
}

// Helper: create a PCM buffer with given RMS energy
function makePcmBuffer(rms, samples = 1200) {
    const buf = Buffer.alloc(samples * 2);
    const amplitude = Math.round(rms * 32767);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    }
    return buf;
}

// ── Tests ──

describe('calculateRMS', () => {
    test('returns 0 for silence', () => {
        const buf = Buffer.alloc(100);
        assert.strictEqual(calculateRMS(buf), 0);
    });

    test('returns 0 for empty buffer', () => {
        assert.strictEqual(calculateRMS(Buffer.alloc(0)), 0);
    });

    test('returns approximate RMS for known signal', () => {
        // A signal alternating between +amplitude and -amplitude
        const samples = 100;
        const amplitude = 16384; // 0.5 of 32768
        const buf = Buffer.alloc(samples * 2);
        for (let i = 0; i < samples; i++) {
            buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
        }
        const rms = calculateRMS(buf);
        // Expected: amplitude / 32768 ≈ 0.5
        assert.ok(rms > 0.49 && rms < 0.51, `Expected ~0.5, got ${rms}`);
    });

    test('returns value above threshold for loud audio', () => {
        const buf = makePcmBuffer(0.5);
        assert.ok(calculateRMS(buf) > WHISPER_VAD.energyThreshold);
    });

    test('returns value below threshold for quiet audio', () => {
        const buf = makePcmBuffer(0.001);
        assert.ok(calculateRMS(buf) < WHISPER_VAD.energyThreshold);
    });
});

describe('VAD state machine', () => {
    test('does not enter speaking state with fewer than 3 voiced frames', () => {
        const state = createVadState();
        const loudBuf = makePcmBuffer(0.5);
        processVAD(state, loudBuf);
        processVAD(state, loudBuf);
        assert.strictEqual(state.isSpeaking, false);
        assert.strictEqual(state.speechFrameCount, 2);
    });

    test('enters speaking state after 3 consecutive voiced frames', () => {
        const state = createVadState();
        const loudBuf = makePcmBuffer(0.5);
        for (let i = 0; i < 3; i++) processVAD(state, loudBuf);
        assert.strictEqual(state.isSpeaking, true);
    });

    test('accumulates buffers while speaking', () => {
        const state = createVadState();
        const loudBuf = makePcmBuffer(0.5);
        for (let i = 0; i < 5; i++) processVAD(state, loudBuf);
        assert.ok(state.speechBuffers.length > 0);
    });

    test('triggers transcribe action after 30 silent frames when buffer is large enough', () => {
        const state = createVadState();
        // Speak for enough frames to build up >= 24000 bytes
        const loudBuf = makePcmBuffer(0.5, 1200); // 1200 samples = 2400 bytes per frame
        for (let i = 0; i < 13; i++) processVAD(state, loudBuf); // 13 * 2400 = 31200 bytes > 24000
        assert.strictEqual(state.isSpeaking, true);

        // Now silence for 30 frames
        const silentBuf = makePcmBuffer(0.001);
        let action = null;
        for (let i = 0; i < 30; i++) {
            const result = processVAD(state, silentBuf);
            if (result.action) action = result.action;
        }
        assert.ok(action !== null, 'Expected transcribe action');
        assert.strictEqual(action.type, 'transcribe');
        assert.ok(action.audio.length >= 24000);
    });

    test('does NOT trigger transcribe if buffer too small', () => {
        const state = createVadState();
        // Only 3 frames of speech = 3 * 2400 = 7200 bytes < 24000
        const loudBuf = makePcmBuffer(0.5, 1200);
        for (let i = 0; i < 3; i++) processVAD(state, loudBuf);

        const silentBuf = makePcmBuffer(0.001);
        let action = null;
        for (let i = 0; i < 30; i++) {
            const result = processVAD(state, silentBuf);
            if (result.action) action = result.action;
        }
        assert.strictEqual(action, null, 'Should not transcribe when buffer too small');
    });

    test('resets speaking state after silence', () => {
        const state = createVadState();
        const loudBuf = makePcmBuffer(0.5, 1200);
        for (let i = 0; i < 13; i++) processVAD(state, loudBuf);
        assert.strictEqual(state.isSpeaking, true);

        const silentBuf = makePcmBuffer(0.001);
        for (let i = 0; i < 30; i++) processVAD(state, silentBuf);
        assert.strictEqual(state.isSpeaking, false);
    });
});

describe('OpenAI SSE streaming parser', () => {
    // Test the SSE parsing logic inline
    function parseSSEChunk(chunk) {
        const tokens = [];
        for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
                const json = JSON.parse(data);
                const token = json.choices?.[0]?.delta?.content || '';
                if (token) tokens.push(token);
            } catch (_) {}
        }
        return tokens;
    }

    test('parses single token from SSE chunk', () => {
        const chunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n';
        assert.deepStrictEqual(parseSSEChunk(chunk), ['Hello']);
    });

    test('handles [DONE] sentinel', () => {
        const chunk = 'data: [DONE]\n';
        assert.deepStrictEqual(parseSSEChunk(chunk), []);
    });

    test('handles multiple tokens in one chunk', () => {
        const chunk = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"choices":[{"delta":{"content":" world"}}]}',
        ].join('\n');
        assert.deepStrictEqual(parseSSEChunk(chunk), ['Hello', ' world']);
    });

    test('skips invalid JSON gracefully', () => {
        const chunk = 'data: not-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n';
        assert.deepStrictEqual(parseSSEChunk(chunk), ['ok']);
    });

    test('handles empty delta content', () => {
        const chunk = 'data: {"choices":[{"delta":{}}]}\n';
        assert.deepStrictEqual(parseSSEChunk(chunk), []);
    });

    test('ignores non-data lines', () => {
        const chunk = 'event: chunk\ndata: {"choices":[{"delta":{"content":"tok"}}]}\n';
        assert.deepStrictEqual(parseSSEChunk(chunk), ['tok']);
    });
});
