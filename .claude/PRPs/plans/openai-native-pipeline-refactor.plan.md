# Plan: OpenAI-Native AI Pipeline Refactor

## Summary
Refactor the BYOK AI pipeline to be OpenAI-native: remove Gemini/Groq provider code, fix transcription + response flow so it actually works end-to-end, and display the full interviewer conversation transcript live in the AssistantView. The `local` and `cloud` provider modes are left untouched.

## User Story
As a user running a BYOK session, I want audio to be transcribed via Whisper, an AI response generated via GPT-4o-mini, and the interviewer's spoken words shown on screen, so I can follow the conversation and get real-time answers without the pipeline silently failing.

## Problem → Solution
**Current state**: BYOK mode passes audio both to a dead Gemini Live session AND to Whisper/OpenAI. The Gemini session is initialized with a Gemini API key that may be absent; if it is absent the session init returns `null`, the `geminiSessionRef.current` stays `null`, and audio is never forwarded. Even if the Gemini session were alive, `sendAudioToGemini` still runs in parallel with Whisper VAD — causing double processing. The transcription pipeline works in isolation but the session startup is gated on the Gemini init.  
**Desired state**: BYOK mode initializes only the OpenAI pipeline (Whisper VAD + GPT-4o-mini). No Gemini SDK is imported or called. Each Whisper transcript is shown in the UI as it arrives. Groq and Gemma code is removed.

## Metadata
- **Complexity**: Large
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 6 (gemini.js, renderer.js, CheatingDaddyApp.js, MainView.js, AssistantView.js, index.js)

---

## UX Design

### Before
```
┌──────────────────────────────────────────────────────┐
│  [BYOK] Starts Gemini Live session (may fail silently)│
│  Audio → Gemini Live (may be null/broken)             │
│  Audio → Whisper VAD (silently, if OpenAI key exists) │
│  Response area: empty / no transcription shown        │
│  Interviewer words: never displayed                   │
└──────────────────────────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────────────────────┐
│  [BYOK] Validates OpenAI key only → starts Whisper    │
│  Audio → Whisper VAD → transcript shown in UI         │
│  Transcript → GPT-4o-mini → streamed response         │
│  AssistantView shows:                                 │
│    [Interviewer]: What's your experience with React?  │
│    [Response]: I've been working with React for 4...  │
└──────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Session start (BYOK) | Calls `initialize-gemini` IPC | Calls new `initialize-openai` IPC | Simpler init |
| Audio data | Sent to Gemini + optionally to Whisper VAD | Sent only to Whisper VAD | One path |
| Transcription | Not shown in UI | Shown as `[Interviewer]: ...` above response | New IPC event `new-transcription` |
| Response | Works when Gemini key present | Works with OpenAI key only | More reliable |
| BYOK key validation | Requires Gemini key OR OpenAI key | Requires OpenAI key only | Simplified |
| MainView BYOK form | Shows Gemini key + Groq key fields | Shows OpenAI key only | Cleaner UI |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/utils/gemini.js` | 1-100 | Module-level state, VAD, transcribeAndRespond |
| P0 | `src/utils/gemini.js` | 266-400 | transcribeAndRespond + sendToOpenAI (the working path) |
| P0 | `src/utils/gemini.js` | 825-953 | macOS audio capture + sendAudioToGemini |
| P0 | `src/utils/gemini.js` | 1011-1210 | All IPC handlers — initialize-gemini, send-audio-content, etc. |
| P0 | `src/index.js` | 1-50 | Main process imports and app setup |
| P1 | `src/utils/renderer.js` | 150-200 | initializeGemini function in renderer |
| P1 | `src/utils/renderer.js` | 207-375 | startCapture — audio routing |
| P1 | `src/components/app/CheatingDaddyApp.js` | 567-621 | handleStart — session init logic |
| P1 | `src/components/views/MainView.js` | 818-872 | _renderByokMode — UI form |
| P2 | `src/components/views/AssistantView.js` | 303-470 | Properties, render, IPC listeners |
| P2 | `src/storage.js` | 14-35 | DEFAULT_CREDENTIALS and DEFAULT_PREFERENCES |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| OpenAI Whisper | https://platform.openai.com/docs/api-reference/audio/createTranscription | multipart/form-data, model: gpt-4o-mini-transcribe, returns {text} |
| OpenAI Chat Completions | https://platform.openai.com/docs/api-reference/chat | model: gpt-4o-mini, stream: true, SSE format |

---

## Patterns to Mirror

### IPC_HANDLER_PATTERN
```js
// SOURCE: src/utils/gemini.js:1034-1042
ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
    currentProviderMode = 'byok';
    const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
    if (session) {
        geminiSessionRef.current = session;
        return true;
    }
    return false;
});
```

### SEND_TO_RENDERER_PATTERN
```js
// SOURCE: src/utils/gemini.js:59-64
function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}
```

### STREAMING_RESPONSE_PATTERN
```js
// SOURCE: src/utils/gemini.js:362-385
const reader = response.body.getReader();
const decoder = new TextDecoder();
let fullText = '';
let isFirst = true;
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
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
```

### WHISPER_VAD_PATTERN
```js
// SOURCE: src/utils/gemini.js:266-305
async function transcribeAndRespond(pcmBuffer) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey) return;
    // ... FormData + fetch to OpenAI transcription endpoint
    // sends transcript to sendToOpenAI(transcript)
}
```

### IPC_RENDERER_LISTENER_PATTERN
```js
// SOURCE: src/components/app/CheatingDaddyApp.js:447-454
ipcRenderer.on('new-response', (_, response) => this.addNewResponse(response));
ipcRenderer.on('update-response', (_, response) => this.updateCurrentResponse(response));
ipcRenderer.on('update-status', (_, status) => this.setStatus(status));
```

### LIT_PROPERTY_PATTERN
```js
// SOURCE: src/components/views/AssistantView.js:303-309
static properties = {
    responses: { type: Array },
    currentResponseIndex: { type: Number },
    selectedProfile: { type: String },
    onSendText: { type: Function },
    shouldAnimateResponse: { type: Boolean },
    isAnalyzing: { type: Boolean, state: true },
};
```

### AUDIO_ROUTING_BYOK_PATTERN
```js
// SOURCE: src/utils/gemini.js:882-888 (macOS audio loop)
if (currentProviderMode === 'cloud') {
    sendCloudAudio(monoChunk);
} else if (currentProviderMode === 'local') {
    getLocalAi().processLocalAudio(monoChunk);
} else {
    if (hasOpenaiKey()) {
        processWhisperVAD(monoChunk);
    }
    // CURRENTLY also calls sendAudioToGemini — this needs to be removed
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/utils/gemini.js` | UPDATE | Remove Gemini init, Groq, Gemma; fix audio routing; add transcription IPC event |
| `src/index.js` | UPDATE | Remove Gemini-specific imports; rename setupGeminiIpcHandlers → setupAiIpcHandlers |
| `src/utils/renderer.js` | UPDATE | Replace initializeGemini with initializeOpenAI; listen for new-transcription |
| `src/components/app/CheatingDaddyApp.js` | UPDATE | Fix handleStart to call initializeOpenAI not initializeGemini |
| `src/components/views/MainView.js` | UPDATE | Remove Groq key field; simplify BYOK form to OpenAI key only |
| `src/components/views/AssistantView.js` | UPDATE | Add transcription display section above response area |

## NOT Building
- Removing Gemini `sendImageToGeminiHttp` — screenshot analysis via Gemini HTTP API still works independently and is valuable. Keep it.
- Removing `@google/genai` from package.json — it's still needed for screenshot analysis.
- Changing local AI mode — untouched.
- Changing cloud mode — untouched.
- Adding new persistent storage fields — transcription is ephemeral UI state.

---

## Step-by-Step Tasks

### Task 1: Fix audio routing in gemini.js — remove Gemini Live from BYOK path
- **ACTION**: In `startMacOSAudioCapture` (line 869) and in `send-audio-content` IPC handler (line 1053), remove the call to `sendAudioToGemini` for BYOK mode. Also remove the call to `geminiSessionRef.current.sendRealtimeInput` when `currentProviderMode` is neither cloud nor local.
- **IMPLEMENT**:
  - In `startMacOSAudioCapture` stdout handler (`src/utils/gemini.js:878-888`): change the `else` branch to just call `processWhisperVAD(monoChunk)` when `hasOpenaiKey()`. Remove `sendAudioToGemini`.
  - In `send-audio-content` handler (`src/utils/gemini.js:1053-1089`): remove the final block that calls `geminiSessionRef.current.sendRealtimeInput` for BYOK mode. Replace with Whisper VAD only.
  - In `send-mic-audio-content` handler (`src/utils/gemini.js:1092-1124`): same — for BYOK, only run Whisper VAD (mic audio), no Gemini session call.
- **MIRROR**: AUDIO_ROUTING_BYOK_PATTERN
- **IMPORTS**: No new imports needed
- **GOTCHA**: The mic channel (`send-mic-audio-content`) currently goes straight to Gemini with no Whisper processing. We need to add `processWhisperVAD` for mic audio too so mic speech is transcribed.
- **VALIDATE**: After this change, BYOK audio paths never call `geminiSessionRef.current` or `sendAudioToGemini`.

### Task 2: Add `initialize-openai` IPC handler and simplify session start
- **ACTION**: Add a new `ipcMain.handle('initialize-openai', ...)` handler in `setupGeminiIpcHandlers` that initializes only the OpenAI pipeline (no Gemini SDK call). Keep `initialize-gemini` as a no-op stub or alias so nothing breaks if called.
- **IMPLEMENT**:
  ```js
  ipcMain.handle('initialize-openai', async (event, customPrompt, profile = 'interview', language = 'en-US') => {
      currentProviderMode = 'byok';
      const openaiApiKey = getOpenaiApiKey();
      if (!openaiApiKey) return false;

      // Re-use existing Google Search check + system prompt setup
      const enabledTools = await getEnabledTools();
      const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);
      const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
      currentSystemPrompt = systemPrompt;

      initializeNewSession(profile, customPrompt);
      sessionParams = { customPrompt, profile, language };

      sendToRenderer('update-status', 'Listening...');
      return true;
  });
  ```
  Place this right after the existing `initialize-gemini` handler.
- **MIRROR**: IPC_HANDLER_PATTERN
- **IMPORTS**: Uses existing `getOpenaiApiKey`, `getEnabledTools`, `getSystemPrompt`, `initializeNewSession` — all already imported/defined in gemini.js
- **GOTCHA**: `getEnabledTools()` reads from the renderer's localStorage — it has a 100ms delay baked in. This is acceptable.
- **VALIDATE**: Calling `ipcRenderer.invoke('initialize-openai', ...)` returns `true` when OpenAI key is set.

### Task 3: Emit `new-transcription` IPC event when Whisper returns a transcript
- **ACTION**: In `transcribeAndRespond` (`src/utils/gemini.js:295-298`), after getting the transcript, emit it to the renderer before calling `sendToOpenAI`.
- **IMPLEMENT**:
  ```js
  if (transcript && transcript.length > 2) {
      console.log('[Whisper] Transcript:', transcript.substring(0, 80));
      sendToRenderer('new-transcription', transcript);  // ← ADD THIS LINE
      sendToOpenAI(transcript);
  }
  ```
- **MIRROR**: SEND_TO_RENDERER_PATTERN
- **IMPORTS**: None — `sendToRenderer` already in scope
- **GOTCHA**: None
- **VALIDATE**: When audio is captured and Whisper runs, renderer receives `new-transcription` event.

### Task 4: Update `renderer.js` — add `initializeOpenAI` and wire transcription display
- **ACTION**: Replace `initializeGemini` with `initializeOpenAI`; add listener for `new-transcription` that calls `cheatingDaddyApp.addTranscription(transcript)`.
- **IMPLEMENT**:
  ```js
  async function initializeOpenAI(profile = 'interview', language = 'en-US') {
      const openaiKey = await storage.getOpenaiApiKey();
      if (!openaiKey) {
          cheatingDaddy.setStatus('No OpenAI key');
          return false;
      }
      const prefs = await storage.getPreferences();
      const success = await ipcRenderer.invoke('initialize-openai', prefs.customPrompt || '', profile, language);
      if (success) {
          cheatingDaddy.setStatus('Listening...');
          return true;
      } else {
          cheatingDaddy.setStatus('error');
          return false;
      }
  }
  ```
  Add `ipcRenderer.on('new-transcription', (event, text) => { cheatingDaddyApp.addTranscription(text); });`
  Update `cheatingDaddy` object: replace `initializeGemini` with `initializeOpenAI`.
- **MIRROR**: IPC_RENDERER_LISTENER_PATTERN
- **GOTCHA**: `cheatingDaddyApp.addTranscription` doesn't exist yet — we add it in Task 6. If the listener fires before the method exists, it will throw. Order: add listener in renderer.js, implement method in CheatingDaddyApp.js in Task 6.
- **VALIDATE**: After starting a session, Whisper transcripts appear in the app.

### Task 5: Update `CheatingDaddyApp.js` handleStart — use `initializeOpenAI`
- **ACTION**: In `handleStart` (`src/components/app/CheatingDaddyApp.js:567-621`), change the `else` (BYOK) branch to call `cheatingDaddy.initializeOpenAI` instead of `cheatingDaddy.initializeGemini`. Also change the key validation to only check the OpenAI key.
- **IMPLEMENT**:
  ```js
  } else {
      const openaiKey = await cheatingDaddy.storage.getOpenaiApiKey().catch(() => '');
      if (!openaiKey || openaiKey === '') {
          const mainView = this.shadowRoot.querySelector('main-view');
          if (mainView && mainView.triggerApiKeyError) {
              mainView.triggerApiKeyError();
          }
          return;
      }
      const success = await cheatingDaddy.initializeOpenAI(this.selectedProfile, this.selectedLanguage);
      if (!success) {
          const mainView = this.shadowRoot.querySelector('main-view');
          if (mainView && mainView.triggerApiKeyError) {
              mainView.triggerApiKeyError();
          }
          return;
      }
  }
  ```
  Also revert the earlier partial diff (the `[geminiKey, openaiKey]` check already there) to this cleaner version.
- **MIRROR**: IPC_RENDERER_LISTENER_PATTERN, AUDIO_ROUTING_BYOK_PATTERN
- **GOTCHA**: The current diff in CheatingDaddyApp.js already partially fixes this — but `await cheatingDaddy.initializeGemini` is still called. We're replacing that whole else-block.
- **VALIDATE**: Starting session with only OpenAI key succeeds.

### Task 6: Add `addTranscription` to CheatingDaddyApp + transcription state
- **ACTION**: Add `transcriptions: []` property to CheatingDaddyApp, add `addTranscription(text)` method, pass `transcriptions` down to AssistantView, wire up IPC listener for `new-transcription` in `connectedCallback`.
- **IMPLEMENT**:
  In `static properties`: add `transcriptions: { type: Array }`.
  In constructor: `this.transcriptions = [];`
  Add method:
  ```js
  addTranscription(text) {
      this.transcriptions = [...this.transcriptions, text];
      this.requestUpdate();
  }
  ```
  In `connectedCallback` add:
  ```js
  ipcRenderer.on('new-transcription', (_, text) => this.addTranscription(text));
  ```
  In `disconnectedCallback` add:
  ```js
  ipcRenderer.removeAllListeners('new-transcription');
  ```
  When rendering `<assistant-view>`, pass `.transcriptions=${this.transcriptions}`.
  Find where `<assistant-view>` is rendered in CheatingDaddyApp.js and add the prop.
  When session ends (handleClose navigating from 'assistant'), reset: `this.transcriptions = [];`
- **MIRROR**: LIT_PROPERTY_PATTERN, IPC_RENDERER_LISTENER_PATTERN
- **GOTCHA**: Need to find the exact line where `<assistant-view>` is rendered. Read CheatingDaddyApp.js render() method to find it before implementing.
- **VALIDATE**: `this.transcriptions` grows as audio is spoken.

### Task 7: Update AssistantView to display transcriptions
- **ACTION**: Add `transcriptions: { type: Array }` property to AssistantView. Add a scrollable transcript panel above the response area showing each transcription as `[Interviewer]: <text>`.
- **IMPLEMENT**:
  Add to `static properties`:
  ```js
  transcriptions: { type: Array },
  ```
  In constructor: `this.transcriptions = [];`
  Add CSS for `.transcript-panel`:
  ```css
  .transcript-panel {
      padding: var(--space-sm) var(--space-md);
      border-bottom: 1px solid var(--border);
      background: var(--bg-surface);
      max-height: 120px;
      overflow-y: auto;
      font-size: var(--font-size-xs);
      color: var(--text-secondary);
      line-height: var(--line-height);
      font-family: var(--font-mono);
  }
  .transcript-line {
      margin: 2px 0;
  }
  .transcript-label {
      color: var(--accent);
      font-weight: var(--font-weight-semibold);
  }
  ```
  In `render()`, before `<div class="response-container">`, add:
  ```js
  ${this.transcriptions && this.transcriptions.length > 0 ? html`
      <div class="transcript-panel">
          ${this.transcriptions.map(t => html`
              <div class="transcript-line">
                  <span class="transcript-label">[Interviewer]</span>: ${t}
              </div>
          `)}
      </div>
  ` : ''}
  ```
  Auto-scroll transcript panel to bottom when new transcription added — in `updated()`:
  ```js
  if (changedProperties.has('transcriptions')) {
      const panel = this.shadowRoot.querySelector('.transcript-panel');
      if (panel) panel.scrollTop = panel.scrollHeight;
  }
  ```
- **MIRROR**: LIT_PROPERTY_PATTERN
- **GOTCHA**: Lit html template literals require `html` tag — already imported. The `map` on transcriptions will throw if `transcriptions` is undefined — initialize to `[]` in constructor.
- **VALIDATE**: When audio spoken, `[Interviewer]: <text>` appears in panel. Panel auto-scrolls.

### Task 8: Clean up MainView.js BYOK form — remove Groq field, simplify
- **ACTION**: Remove the Groq API key input from `_renderByokMode()`. Remove the Gemini key field label's "optional — for screenshots" framing — keep the field since screenshot analysis via Gemini HTTP still works. Update the start validation in `_handleStart()` to only check `_openaiKey`.
- **IMPLEMENT**:
  In `_renderByokMode()` (`src/components/views/MainView.js:818-872`): remove the entire Groq form-group block (lines ~850-861). 
  In `_handleStart()` (`src/components/views/MainView.js:752-766`): change BYOK check to:
  ```js
  if (this._mode === 'byok') {
      if (!this._openaiKey.trim()) {
          this._keyError = true;
          this.requestUpdate();
          return;
      }
  }
  ```
  Remove `_groqKey` from `static properties` and constructor.
  Remove `_saveGroqKey` method.
  Remove `this._groqKey = await cheatingDaddy.storage.getGroqApiKey()...` from `_loadFromStorage`.
- **MIRROR**: LIT_PROPERTY_PATTERN
- **GOTCHA**: `_groqKey` state is only used in MainView — removing it is safe. Keep `_geminiKey` since Gemini HTTP screenshots still need the key.
- **VALIDATE**: BYOK form shows only OpenAI key + Gemini key fields. Start button active only when OpenAI key is present.

### Task 9: Update index.js imports
- **ACTION**: Rename `setupGeminiIpcHandlers` import to avoid confusion (or leave as-is since it still sets up all IPC handlers). Remove `geminiSessionRef` from the startup logic if it's no longer needed for BYOK — but keep it since `initialize-gemini` IPC still exists as a stub.
- **IMPLEMENT**:
  In `src/index.js:7`: The import `{ setupGeminiIpcHandlers, stopMacOSAudioCapture, sendToRenderer }` can stay as-is — the function names haven't changed.
  In `setupGeneralIpcHandlers` (`src/index.js:310`): `updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef)` — `geminiSessionRef` is still passed but only used for Gemini session shortcuts (if any). Keep as-is to avoid breaking shortcut logic.
- **MIRROR**: IPC_HANDLER_PATTERN
- **GOTCHA**: `geminiSessionRef.current` will be `null` for BYOK sessions after this refactor — any code that tries to use it for BYOK will be a no-op since we removed those call sites in Task 1.
- **VALIDATE**: App starts without errors.

---

## Testing Strategy

### Manual Validation Steps
1. Launch app with `npm start` (or `electron-forge start`)
2. Enter only OpenAI API key in BYOK form — Start button becomes active
3. Click Start Session
4. Speak — status shows "Transcribing..." briefly then "Listening..."
5. Transcription appears in `[Interviewer]:` panel
6. AI response streams into response area
7. Enter a screenshot on a question page (Ctrl+Enter) — should still work if Gemini key provided
8. Start Session with no keys → error state shown

### Unit Tests
No test framework is configured in this project (`package.json` has no test script). Skip.

### Edge Cases Checklist
- [ ] Session start with empty OpenAI key → error shown
- [ ] Session start with only Gemini key (no OpenAI) → error (no longer allowed)
- [ ] Session start with both keys → works normally
- [ ] Very short audio below 24000 bytes threshold → no transcription call made (VAD handles this)
- [ ] Whisper API failure (bad key, network) → status shows error, no crash
- [ ] GPT-4o-mini API failure → status shows error, no crash
- [ ] Local mode start → unaffected (no OpenAI key needed)
- [ ] macOS: audio from SystemAudioDump correctly routes to Whisper VAD only

---

## Validation Commands

### Static Analysis
```bash
# No TypeScript — JS only, no build step needed
# Check for obvious syntax errors:
node --check src/index.js && node --check src/utils/gemini.js && node --check src/utils/renderer.js
```
EXPECT: No syntax errors

### Manual App Launch
```bash
cd /home/haojun03/code/cheating-daddy
npm start
```
EXPECT: App launches, no console errors in main process

### Manual Validation
- [ ] BYOK form shows only OpenAI key + Gemini key (no Groq field)
- [ ] Start Session with OpenAI key → session begins, status "Listening..."
- [ ] Speak audio → `[Interviewer]: <text>` appears in transcript panel
- [ ] After transcription → AI response appears in response area
- [ ] Screenshot analysis (Ctrl+Enter) still works with Gemini key
- [ ] No Gemini Live session initialization errors in console

---

## Acceptance Criteria
- [ ] BYOK sessions work with OpenAI key only (no Gemini key required)
- [ ] Whisper transcribes audio and shows `[Interviewer]: ...` in the UI
- [ ] GPT-4o-mini responses stream into the response area
- [ ] No Groq/Gemma code runs during a BYOK session
- [ ] No Gemini Live SDK called during a BYOK session
- [ ] Local and cloud modes remain unaffected
- [ ] Screenshot analysis (Gemini HTTP) still works when Gemini key is provided
- [ ] No console errors during a normal BYOK session

## Completion Checklist
- [ ] gemini.js: BYOK audio path calls only processWhisperVAD, no sendAudioToGemini
- [ ] gemini.js: `initialize-openai` IPC handler added
- [ ] gemini.js: `transcribeAndRespond` emits `new-transcription` event
- [ ] renderer.js: `initializeOpenAI` function replaces `initializeGemini`
- [ ] renderer.js: `new-transcription` listener calls `addTranscription`
- [ ] CheatingDaddyApp.js: `handleStart` BYOK path calls `initializeOpenAI`
- [ ] CheatingDaddyApp.js: `transcriptions` state + `addTranscription` method added
- [ ] CheatingDaddyApp.js: `new-transcription` IPC listener registered
- [ ] AssistantView.js: `transcriptions` prop + transcript panel rendered
- [ ] MainView.js: Groq key field removed, validation uses only OpenAI key

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mic audio path also needs Whisper VAD | HIGH | Mic speech not transcribed | Task 1 explicitly handles mic channel |
| `addTranscription` called before CheatingDaddyApp renders | LOW | Silent error | Initialize `transcriptions = []` in constructor |
| Removing Gemini Live breaks screenshot analysis | MEDIUM | Screenshots stop working | Screenshot uses separate `sendImageToGeminiHttp` path — kept intact |
| `geminiSessionRef.current` null dereference | LOW | Error during session | Task 1 removes all BYOK callers of this ref |

## Notes
- The `sendToOpenAI` function already works correctly — the bug is that session startup fails silently when no Gemini key is present, causing `geminiSessionRef.current` to be null, and audio never flows through the Whisper path if the audio handler exits early when the Gemini session is null.
- The Whisper VAD threshold `24000 bytes` (~0.5s at 24kHz 16-bit mono) is already well-tuned; don't change it.
- Keep `sendToGroq`, `sendToGemma`, `sendToOpenAI`, and `initializeGeminiSession` functions in the file as dead code for now — removing them is a separate cleanup task and carries risk of missing call sites.
- The `groqConversationHistory` variable name is legacy; it's reused as the conversation history for OpenAI. Leave it renamed as a follow-up.
