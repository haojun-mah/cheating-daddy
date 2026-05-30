# Implementation Plan: OpenAI API + gpt-4o-mini-transcribe (Windows-First)

## Pricing Research
- **gpt-4o-mini-transcribe**: $0.003/min — ~**$0.06–$0.09 per 30-min interview session**
- **gpt-4o-mini** (chat): ~$0.15/M input tokens, $0.60/M output tokens — negligible per session
- **Verdict**: Cheap enough to use unconditionally when an OpenAI key is present

---

## Architecture Discoveries (from full codebase read)

### Windows audio capture already works correctly
`setupWindowsLoopbackProcessing()` in `renderer.js:431` captures system audio (loopback) via `getDisplayMedia({ audio: 'loopback' })` and sends it via `send-audio-content`. Mic is only added if `audioMode === 'both'`. The `audioMode` preference already defaults to `'speaker_only'` in `storage.js:26`. **Windows is already capturing interviewer-only audio.**

### macOS also already speaker-only by default
`audioMode` defaults `'speaker_only'` — mic is not started unless `audioMode === 'mic_only' || 'both'` (renderer.js:229). The macOS path uses `SystemAudioDump` for system audio.

### Current transcription pipeline (the slow part)
```
Audio chunks → Gemini Live session → inputTranscription (with speaker diarization)
→ waits for generationComplete → then dispatches to Groq/Gemma
```
The `generationComplete` event is Gemini deciding the turn is done — this adds latency. We want to replace this with:
```
Audio chunks (system/loopback) → VAD silence detection → OpenAI Whisper API (~300ms)
→ immediately stream to GPT-4o-mini chat completions
```

### Current response dispatch (gemini.js:488-498)
```js
if (message.serverContent?.generationComplete) {
    if (hasGroqKey()) sendToGroq(currentTranscription);
    else sendToGemma(currentTranscription);
}
```
We insert OpenAI at the top: `if (hasOpenaiKey()) sendToOpenAI(...)`.

### OpenAI key already has UI state in MainView
`_openaiKey` state exists at `MainView.js:494`, `_saveOpenaiKey` at line 719-725 — already saves to credentials via `setCredentials({ openaiKey: val })`. But the field is **never rendered** in `_renderByokMode()`. And storage uses key name `openaiKey` (in creds) but the new code should store as `openaiApiKey` consistently.

### Where to add Whisper VAD
The VAD + silence detection already exists in `localai.js` (lines 76-111). We replicate the same approach in `gemini.js` for the system audio stream, but call the OpenAI Whisper API instead of the local Whisper model.

The system audio arrives at `gemini.js:696` in `startMacOSAudioCapture` and at the Gemini session send path. On Windows/Linux, audio arrives via `send-audio-content` IPC handler (gemini.js:877). We need to intercept these buffers and run VAD.

---

## What Changes (Windows-First Priority)

### Priority 1: OpenAI as primary response backend (all platforms)
Replace Groq/Gemma with GPT-4o-mini when an OpenAI key is present.

### Priority 2: OpenAI Whisper for transcription (all platforms)  
On Windows, audio arrives via `send-audio-content`. Buffer it, run VAD, call Whisper API. This is faster than waiting for Gemini's `generationComplete`.

When OpenAI key present:
- Buffer incoming audio chunks with VAD
- On silence: POST to `/v1/audio/transcriptions` with `gpt-4o-mini-transcribe`
- On transcript: immediately stream to GPT-4o-mini
- Suppress the Gemini `generationComplete` dispatch (or keep Gemini entirely optional)

### Priority 3: Gemini Live becomes optional
With OpenAI doing both transcription + responses, we can make the Gemini API key optional. The user only needs an OpenAI key for the full experience on Windows. Gemini key = fallback or for screenshot analysis (the `sendImageToGeminiHttp` path still needs it).

---

## Implementation Steps

### Step 1: Storage — add `openaiApiKey` consistently
**File**: `src/storage.js`

```js
// DEFAULT_CREDENTIALS
const DEFAULT_CREDENTIALS = {
    apiKey: '',        // Gemini
    groqApiKey: '',
    openaiApiKey: ''   // Add this
};

function getOpenaiApiKey() {
    return getCredentials().openaiApiKey || '';
}
function setOpenaiApiKey(openaiApiKey) {
    return setCredentials({ openaiApiKey });
}
// Export both
```

Note: `MainView._saveOpenaiKey` currently stores as `openaiKey` (not `openaiApiKey`). Fix this in Step 5 to use `openaiApiKey` consistently.

### Step 2: IPC handlers for OpenAI key
**File**: `src/index.js`

Add alongside the Groq key handlers (around line 121):
```js
ipcMain.handle('storage:get-openai-api-key', async () => {
    try { return { success: true, data: storage.getOpenaiApiKey() }; }
    catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('storage:set-openai-api-key', async (event, key) => {
    try { storage.setOpenaiApiKey(key); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
});
```

### Step 3: Expose OpenAI key in renderer storage API
**File**: `src/utils/renderer.js`

Add to the `storage` object (after `setGroqApiKey`):
```js
async getOpenaiApiKey() {
    const result = await ipcRenderer.invoke('storage:get-openai-api-key');
    return result.success ? result.data : '';
},
async setOpenaiApiKey(key) {
    return ipcRenderer.invoke('storage:set-openai-api-key', key);
},
```

### Step 4: Add `pcmToWavBuffer()` — in-memory WAV (no disk I/O)
**File**: `src/audioUtils.js`

Existing `pcmToWav` writes to disk. Add a new memory-only version:
```js
function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmBuffer]);
}
module.exports = { pcmToWav, pcmToWavBuffer, analyzeAudioBuffer, saveDebugAudio };
```

### Step 5: Main backend changes — `src/utils/gemini.js`

#### 5a: Import new storage getter + audioUtils
```js
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, getOpenaiApiKey,
        incrementCharUsage, getModelForToday } = require('../storage');
const { saveDebugAudio, pcmToWavBuffer } = require('../audioUtils');
```

#### 5b: Add `hasOpenaiKey()` helper
```js
function hasOpenaiKey() {
    const key = getOpenaiApiKey();
    return key && key.trim() !== '';
}
```

#### 5c: Add `sendToOpenAI(transcription)` — identical streaming pattern to `sendToGroq`
```js
async function sendToOpenAI(transcription) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey || !transcription?.trim()) return;

    groqConversationHistory.push({ role: 'user', content: transcription.trim() });
    if (groqConversationHistory.length > 20) groqConversationHistory = groqConversationHistory.slice(-20);

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                    ...groqConversationHistory
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 1024
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenAI API error:', response.status, errorText);
            sendToRenderer('update-status', `OpenAI error: ${response.status}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let isFirst = true;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n').filter(l => l.trim())) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        fullText += token;
                        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                        isFirst = false;
                    }
                } catch (_) {}
            }
        }

        if (fullText.trim()) {
            groqConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(transcription, fullText);
        }
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling OpenAI API:', error);
        sendToRenderer('update-status', 'OpenAI error: ' + error.message);
    }
}
```

#### 5d: Update `generationComplete` dispatch (gemini.js ~line 488)
```js
if (message.serverContent?.generationComplete) {
    if (currentTranscription.trim() !== '') {
        if (hasOpenaiKey()) sendToOpenAI(currentTranscription);
        else if (hasGroqKey()) sendToGroq(currentTranscription);
        else sendToGemma(currentTranscription);
        currentTranscription = '';
    }
    messageBuffer = '';
}
```

Also update the `send-text-message` handler (~line 1015):
```js
if (hasOpenaiKey()) sendToOpenAI(text.trim());
else if (hasGroqKey()) sendToGroq(text.trim());
else sendToGemma(text.trim());
```

#### 5e: Add Whisper VAD for faster transcription on Windows/Linux

Add VAD state (parallel to localai.js approach):
```js
// Whisper VAD state (for when OpenAI key is present)
let whisperVadState = {
    isSpeaking: false,
    speechBuffers: [],
    silenceFrameCount: 0,
    speechFrameCount: 0,
};
const WHISPER_VAD = { energyThreshold: 0.008, speechFramesRequired: 3, silenceFramesRequired: 30 };

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

async function processWhisperVAD(pcmBuffer) {
    const rms = calculateRMS(pcmBuffer);
    const isVoice = rms > WHISPER_VAD.energyThreshold;

    if (isVoice) {
        whisperVadState.speechFrameCount++;
        whisperVadState.silenceFrameCount = 0;
        if (!whisperVadState.isSpeaking && whisperVadState.speechFrameCount >= WHISPER_VAD.speechFramesRequired) {
            whisperVadState.isSpeaking = true;
            whisperVadState.speechBuffers = [];
        }
    } else {
        whisperVadState.silenceFrameCount++;
        whisperVadState.speechFrameCount = 0;
        if (whisperVadState.isSpeaking && whisperVadState.silenceFrameCount >= WHISPER_VAD.silenceFramesRequired) {
            whisperVadState.isSpeaking = false;
            const audioData = Buffer.concat(whisperVadState.speechBuffers);
            whisperVadState.speechBuffers = [];
            // Min length check: ~0.5s at 24kHz 16-bit mono = 24000 bytes
            if (audioData.length >= 24000) {
                transcribeAndRespond(audioData);
            }
            return;
        }
    }
    if (whisperVadState.isSpeaking) {
        whisperVadState.speechBuffers.push(Buffer.from(pcmBuffer));
    }
}

async function transcribeAndRespond(pcmBuffer) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey) return;

    sendToRenderer('update-status', 'Transcribing...');

    try {
        // Build WAV in memory
        const wavBuffer = pcmToWavBuffer(pcmBuffer, 24000, 1, 16);
        
        // Use FormData — available in Node 18+ (Electron ships Node 20+)
        const formData = new FormData();
        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        formData.append('file', wavBlob, 'audio.wav');
        formData.append('model', 'gpt-4o-mini-transcribe');
        formData.append('language', sessionParams?.language?.split('-')[0] || 'en');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiApiKey}` },
            body: formData
        });

        if (!response.ok) {
            console.error('Whisper API error:', response.status);
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        const result = await response.json();
        const transcript = result.text?.trim();

        if (transcript && transcript.length > 2) {
            console.log('[Whisper] Transcript:', transcript.substring(0, 80));
            // Use currentTranscription accumulation pattern for consistency
            currentTranscription = transcript;
            sendToOpenAI(currentTranscription);
            currentTranscription = '';
        }

        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[Whisper] Transcription error:', error);
        sendToRenderer('update-status', 'Listening...');
    }
}
```

#### 5f: Hook VAD into `send-audio-content` IPC handler

In the `send-audio-content` handler (~line 877), when in BYOK mode and OpenAI key present, run VAD in parallel:
```js
ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
    // ... existing cloud/local checks ...
    
    if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
    try {
        process.stdout.write('.');
        
        // Run Whisper VAD in parallel when OpenAI key is present
        if (hasOpenaiKey()) {
            const pcmBuffer = Buffer.from(data, 'base64');
            processWhisperVAD(pcmBuffer); // fire-and-forget, non-blocking
        }
        
        await geminiSessionRef.current.sendRealtimeInput({
            audio: { data: data, mimeType: mimeType },
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});
```

Also hook into `startMacOSAudioCapture` for macOS (the monoChunk path at line 704):
```js
// Before sendAudioToGemini:
if (hasOpenaiKey()) {
    processWhisperVAD(monoChunk); // fire-and-forget
}
```

#### 5g: Disable Gemini `generationComplete` dispatch when OpenAI handles it
When using Whisper VAD, the Gemini transcription path becomes redundant (it would double-fire). Add a gate:
```js
if (message.serverContent?.generationComplete) {
    // Only dispatch via Gemini path if Whisper VAD is NOT active
    if (!hasOpenaiKey() && currentTranscription.trim() !== '') {
        if (hasGroqKey()) sendToGroq(currentTranscription);
        else sendToGemma(currentTranscription);
        currentTranscription = '';
    }
    messageBuffer = '';
}
```

### Step 6: UI — wire OpenAI key field in MainView BYOK mode
**File**: `src/components/views/MainView.js`

The `_openaiKey` state and `_saveOpenaiKey` method already exist. `_saveOpenaiKey` currently stores with key `openaiKey` in credentials — update it to use `openaiApiKey`:

```js
async _saveOpenaiKey(val) {
    this._openaiKey = val;
    // Fix: use openaiApiKey key name consistently with storage layer
    await cheatingDaddy.storage.setOpenaiApiKey(val);
    this.requestUpdate();
}
```

Update `_loadFromStorage` to load using the new IPC:
```js
this._openaiKey = await cheatingDaddy.storage.getOpenaiApiKey().catch(() => '') || '';
```

In `_renderByokMode()`, add the OpenAI key field **above** Gemini key (since OpenAI is now the priority):
```html
<div class="form-group">
    <label class="form-label">OpenAI API Key <span style="opacity:0.5;font-weight:400">(recommended)</span></label>
    <input
        type="password"
        placeholder="Required for fast transcription"
        .value=${this._openaiKey}
        @input=${e => this._saveOpenaiKey(e.target.value)}
    />
    <div class="form-hint">
        Powers GPT-4o-mini-transcribe + GPT-4o-mini responses · ~$0.06/session ·
        <span class="link" @click=${() => this.onExternalLink('https://platform.openai.com/api-keys')}>Get key</span>
    </div>
</div>

<div class="form-group">
    <label class="form-label">Gemini API Key <span style="opacity:0.5;font-weight:400">(optional — for screenshots)</span></label>
    <input
        type="password"
        placeholder="Optional"
        .value=${this._geminiKey}
        @input=${e => this._saveGeminiKey(e.target.value)}
        class=${this._keyError ? 'error' : ''}
    />
    <div class="form-hint">
        <span class="link" @click=${() => this.onExternalLink('https://aistudio.google.com/apikey')}>Get Gemini key</span>
        · needed for screenshot Q&A
    </div>
</div>
```

Update `_handleStart()` validation: if `openaiKey` is present, a Gemini key is not required:
```js
_handleStart() {
    if (this.isInitializing) return;
    if (this._mode === 'byok') {
        // OpenAI key alone is sufficient
        if (!this._openaiKey.trim() && !this._geminiKey.trim()) {
            this._keyError = true;
            this.requestUpdate();
            return;
        }
    }
    // ...
    this.onStart();
}
```

Also update `initializeGemini` in renderer.js to be a no-op when no Gemini key (OpenAI handles everything):
```js
async function initializeGemini(profile = 'interview', language = 'en-US') {
    const apiKey = await storage.getApiKey();
    if (!apiKey) {
        // No Gemini key — that's OK if OpenAI key is present
        cheatingDaddy.setStatus('Ready (OpenAI mode)');
        return;
    }
    // ... existing Gemini init ...
}
```

---

## Key Files Summary

| File | Operation | Lines affected |
|------|-----------|----------------|
| `src/storage.js` | Add `openaiApiKey` to credentials, getter/setter | ~14, ~200-210 |
| `src/index.js` | Add 2 IPC handlers for openai key | after line ~138 |
| `src/utils/renderer.js` | Add `getOpenaiApiKey`/`setOpenaiApiKey` to storage object; update `initializeGemini` no-op | ~56-58, ~143 |
| `src/audioUtils.js` | Add `pcmToWavBuffer()` | end of file |
| `src/utils/gemini.js` | Add `hasOpenaiKey`, `sendToOpenAI`, `processWhisperVAD`, `transcribeAndRespond`; update dispatch, hook VAD into audio handlers | major additions ~50-350 |
| `src/components/views/MainView.js` | Render OpenAI key field, update `_saveOpenaiKey`, update `_handleStart` validation, fix `_loadFromStorage` | ~534, ~719, ~754, ~821 |

---

## Risks and Mitigation

| Risk | Mitigation |
|------|------------|
| `FormData` + `Blob` in Node.js main process — supported in Node 18+ (Electron ships Node 20+, so OK) | Verify Electron's Node version via `process.versions.node` at runtime |
| Whisper VAD double-fires with Gemini transcription when both paths active | Gate: `if (!hasOpenaiKey())` around Gemini `generationComplete` dispatch (Step 5g) |
| VAD threshold too sensitive/insensitive for interview audio | Use same `VERY_AGGRESSIVE` params from localai.js; threshold tunable |
| `gpt-4o-mini-transcribe` model name may change (OpenAI API versioning) | Store model name as a constant `WHISPER_MODEL = 'gpt-4o-mini-transcribe'` at top of file |
| Windows loopback audio arrives at 24kHz; Whisper API accepts any common rate | 24kHz WAV is valid — no resampling needed (unlike localai.js which must go 24→16kHz for local Whisper) |
| Session without Gemini key fails to init properly | Step 6's `initializeGemini` no-op + `sessionActive` flag set correctly even without Gemini |

---

## Build Order

1. `src/storage.js`
2. `src/index.js`
3. `src/utils/renderer.js`
4. `src/audioUtils.js`
5. `src/utils/gemini.js` (biggest change)
6. `src/components/views/MainView.js`

---

## Cost Summary (OpenAI-only session, 30-min interview)
| Item | Cost |
|------|------|
| Whisper transcription (20 min speech @ $0.003/min) | ~$0.06 |
| GPT-4o-mini responses (10 turns, ~500 tokens each) | ~$0.003 |
| **Total per session** | **~$0.06** |

---

## SESSION_ID
- CODEX_SESSION: N/A
- GEMINI_SESSION: N/A
