# Plan: OpenAI-Native Chat Transcription

## Summary
Remove Gemini and Groq from the AI response pipeline and make OpenAI the sole provider for both transcription (Whisper) and answering (GPT-4o-mini). Replace the single-response display in AssistantView with a scrolling chat interface that shows each interviewer utterance as a transcribed message followed by an instantly generated AI answer, creating a live conversation feed.

## User Story
As an interview candidate using Cheating Daddy, I want every word the interviewer says to appear as a transcribed message in a scrolling chat, with an AI-generated answer appearing immediately below it, so that I can follow the conversation in real-time without navigating between responses.

## Problem → Solution
**Current state**: Audio is transcribed by Gemini live session; answers come from Groq (primary), Gemini (fallback), or OpenAI (if key present). The AssistantView shows one response at a time with Previous/Next navigation arrows.

**Desired state**: OpenAI Whisper handles all transcription via VAD; GPT-4o-mini streams the answer. The AssistantView shows a scrolling chat log: each entry has an "Interviewer" bubble with the transcribed text, followed immediately by an "AI Answer" bubble that streams in token by token.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 5
- **Estimated Tasks**: 7

---

## UX Design

### Before
```
┌──────────────────────────────────────┐
│  [Single response area, markdown]    │
│                                      │
│  "Here is the answer to question..." │
│                                      │
│   ← 1 of 3 →                        │
│  [Type a message...]  [Analyze Scr]  │
└──────────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────┐
│  [Chat scroll area]                  │
│                                      │
│  Interviewer                         │
│  ┌──────────────────────────────┐    │
│  │ Tell me about yourself...    │    │
│  └──────────────────────────────┘    │
│                                      │
│  AI Answer                           │
│  ┌──────────────────────────────┐    │
│  │ I'm a software engineer with │    │
│  │ 5 years of experience...▌    │    │
│  └──────────────────────────────┘    │
│                                      │
│  Interviewer                         │
│  ┌──────────────────────────────┐    │
│  │ What's your biggest weakness?│    │
│  └──────────────────────────────┘    │
│  (AI Answer streaming...)            │
│  [Type a message...]  [Analyze Scr]  │
└──────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Transcription | Gemini live session → Groq/Gemma | OpenAI Whisper VAD only | VAD already exists, just remove fallbacks |
| Response display | Single response, navigate with arrows | Chat scroll, all turns visible | New chat bubble components |
| New transcription arrives | Fires `new-response` / `update-response` | Fires `new-turn-transcription` with text, then `update-turn-answer` with streaming | New IPC events |
| AI response streaming | Replaces single `update-response` | Updates the last answer bubble | Linked by turn index |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/utils/gemini.js` | 1-400 | Core audio pipeline, VAD, transcribeAndRespond, sendToOpenAI |
| P0 | `src/components/views/AssistantView.js` | 1-712 | Current single-response view to be replaced with chat |
| P0 | `src/components/app/CheatingDaddyApp.js` | 440-530 | IPC listeners for `new-response`/`update-response`, `addNewResponse`/`updateCurrentResponse` |
| P1 | `src/utils/renderer.js` | 200-210 | `ipcRenderer.on('update-status')` pattern to mirror for new events |
| P1 | `src/storage.js` | 1-50 | DEFAULT_CREDENTIALS shape (apiKey=Gemini, groqApiKey, openaiApiKey) |
| P2 | `src/index.js` | 1-50 | App startup, `setupGeminiIpcHandlers` call |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| OpenAI Whisper API | Already implemented in gemini.js:266-305 | Use `gpt-4o-mini-transcribe` model, `audio/wav` FormData upload |
| OpenAI Chat Completions SSE | Already implemented in gemini.js:327-398 | `data: [DONE]` sentinel, `choices[0].delta.content` tokens |
| Lit web components | src/assets/lit-core-2.7.4.min.js | Use `html`, `css`, `LitElement` from local asset — no npm import |

---

## Patterns to Mirror

### IPC_EVENT_SEND
```js
// SOURCE: src/utils/gemini.js:59-64
function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}
```

### IPC_EVENT_LISTEN
```js
// SOURCE: src/components/app/CheatingDaddyApp.js:448-454
if (window.require) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.on('new-response', (_, response) => this.addNewResponse(response));
    ipcRenderer.on('update-response', (_, response) => this.updateCurrentResponse(response));
}
```

### LIT_COMPONENT_STRUCTURE
```js
// SOURCE: src/components/views/AssistantView.js:1-15
import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`...`;
    static properties = { responses: { type: Array }, ... };
    constructor() { super(); this.responses = []; }
    render() { return html`...`; }
}
customElements.define('assistant-view', AssistantView);
```

### LIT_PROPERTY_UPDATE
```js
// SOURCE: src/components/app/CheatingDaddyApp.js:507-524
addNewResponse(response) {
    const wasOnLatest = this.currentResponseIndex === this.responses.length - 1;
    this.responses = [...this.responses, response];  // immutable push
    if (wasOnLatest || this.currentResponseIndex === -1) {
        this.currentResponseIndex = this.responses.length - 1;
    }
    this.requestUpdate();
}
```

### OPENAI_WHISPER_CALL
```js
// SOURCE: src/utils/gemini.js:273-304
const wavBuffer = pcmToWavBuffer(pcmBuffer, 24000, 1, 16);
const formData = new FormData();
const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
formData.append('file', wavBlob, 'audio.wav');
formData.append('model', WHISPER_MODEL);
const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiApiKey}` },
    body: formData,
});
```

### OPENAI_CHAT_SSE_STREAM
```js
// SOURCE: src/utils/gemini.js:362-384
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

### CSS_DESIGN_TOKENS
```css
/* SOURCE: src/index.html:8-125 (CSS variables) */
/* Use these tokens, never hardcode colors */
--bg-app, --bg-surface, --bg-elevated, --bg-hover
--text-primary, --text-secondary, --text-muted
--border, --border-strong, --accent
--space-xs (4px), --space-sm (8px), --space-md (16px), --space-lg (24px)
--radius-sm (4px), --radius-md (8px), --radius-lg (12px)
--font-size-xs (11px), --font-size-sm (13px), --font-size-base (14px)
--font-mono, --font-weight-medium, --font-weight-semibold
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `src/utils/gemini.js` | UPDATE | Remove Groq/Gemma dispatch; send new IPC events with transcription text + turn index |
| `src/components/app/CheatingDaddyApp.js` | UPDATE | Add `chatTurns` state; listen for new IPC events; pass turns to AssistantView |
| `src/components/views/AssistantView.js` | UPDATE | Replace single-response view with scrolling chat bubbles |
| `src/index.js` | UPDATE | Remove Groq storage IPC handler references (optional cleanup) |

## NOT Building
- Removing local AI mode (Ollama/Whisper pipeline) — local mode stays intact
- Removing cloud mode — cloud mode stays intact
- Removing Gemini live session for audio input — Gemini still feeds audio, just not for chat responses
- Removing Gemini for image analysis — `sendImageToGeminiHttp` stays (screenshot feature)
- Adding user-configurable model selection for OpenAI chat model
- Removing Groq storage fields from storage.js — keep for backwards compatibility

---

## Step-by-Step Tasks

### Task 1: Refactor `gemini.js` — remove Groq/Gemma dispatch, add turn-based IPC
- **ACTION**: In `initializeGeminiSession`'s `onmessage` callback, remove the Groq/Gemma branch entirely. In `transcribeAndRespond`, after getting the transcript from Whisper, emit a new `new-turn-transcription` IPC event with `{ turnIndex, text }` before calling `sendToOpenAI`. In `sendToOpenAI`, add a `turnIndex` parameter and emit `update-turn-answer` with `{ turnIndex, text: fullText }` on each streaming token.
- **IMPLEMENT**:
  ```js
  // new module-level turn counter
  let currentTurnIndex = 0;

  async function transcribeAndRespond(pcmBuffer) {
      const openaiApiKey = getOpenaiApiKey();
      if (!openaiApiKey) return;
      sendToRenderer('update-status', 'Transcribing...');
      try {
          // ... existing Whisper call unchanged ...
          const transcript = result.text?.trim();
          if (transcript && transcript.length > 2) {
              const turnIndex = currentTurnIndex++;
              sendToRenderer('new-turn-transcription', { turnIndex, text: transcript });
              sendToOpenAI(transcript, turnIndex);
          }
          sendToRenderer('update-status', 'Listening...');
      } catch (error) {
          console.error('[Whisper] Transcription error:', error);
          sendToRenderer('update-status', 'Listening...');
      }
  }

  async function sendToOpenAI(transcription, turnIndex) {
      // ... existing setup ...
      // Change streaming renderer calls:
      if (token) {
          fullText += token;
          sendToRenderer('update-turn-answer', { turnIndex, text: fullText });
      }
      // ... rest unchanged ...
  }
  ```
- **MIRROR**: IPC_EVENT_SEND pattern
- **IMPORTS**: No new imports needed
- **GOTCHA**: `currentTurnIndex` must be reset to 0 in `initializeNewSession()` to avoid stale indices on session restart. Also remove the `if (!hasOpenaiKey() && currentTranscription.trim() !== '') { if (hasGroqKey()) { sendToGroq... } else { sendToGemma... } }` block from the Gemini `onmessage` handler (lines 663-669 in gemini.js). Keep the `if (hasOpenaiKey()) { processWhisperVAD(monoChunk); }` check in audio paths — that's the VAD trigger.
- **VALIDATE**: After change: only `transcribeAndRespond` → `sendToOpenAI` path fires. Groq and Gemma functions remain in file but are never called. Check that `currentTurnIndex++` happens before `sendToOpenAI` so both events carry the same index.

### Task 2: Update `sendTextMessage` IPC handler in `gemini.js`
- **ACTION**: In `send-text-message` handler, when `hasOpenaiKey()` is true, also emit a `new-turn-transcription` event before calling `sendToOpenAI`, so manual text messages also appear as chat turns.
- **IMPLEMENT**:
  ```js
  if (hasOpenaiKey()) {
      const turnIndex = currentTurnIndex++;
      sendToRenderer('new-turn-transcription', { turnIndex, text: text.trim() });
      sendToOpenAI(text.trim(), turnIndex);
  }
  ```
- **MIRROR**: IPC_EVENT_SEND pattern
- **GOTCHA**: The existing fallback `await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() })` should remain after the OpenAI call so Gemini still receives the text for audio context.
- **VALIDATE**: Typing a message in the text input shows a "Interviewer" bubble immediately, followed by streaming AI answer.

### Task 3: Add `chatTurns` state to `CheatingDaddyApp.js`
- **ACTION**: Add `chatTurns` as a Lit reactive property (array of `{ turnIndex, transcription, answer, isAnswering }`). Listen for `new-turn-transcription` and `update-turn-answer` IPC events. Add `handleNewTurn` and `handleUpdateTurnAnswer` methods. Reset `chatTurns` when session starts.
- **IMPLEMENT**:
  ```js
  // In static properties:
  chatTurns: { type: Array },

  // In constructor:
  this.chatTurns = [];

  // In connectedCallback (alongside existing IPC listeners):
  ipcRenderer.on('new-turn-transcription', (_, data) => this.handleNewTurn(data));
  ipcRenderer.on('update-turn-answer', (_, data) => this.handleUpdateTurnAnswer(data));

  // New methods:
  handleNewTurn({ turnIndex, text }) {
      this.chatTurns = [...this.chatTurns, {
          turnIndex,
          transcription: text,
          answer: '',
          isAnswering: true,
      }];
      this.requestUpdate();
  }

  handleUpdateTurnAnswer({ turnIndex, text }) {
      this.chatTurns = this.chatTurns.map(turn =>
          turn.turnIndex === turnIndex
              ? { ...turn, answer: text, isAnswering: text.length === 0 }
              : turn
      );
      this.requestUpdate();
  }

  // In handleStart(), after this.responses = []:
  this.chatTurns = [];
  ```
- **MIRROR**: LIT_PROPERTY_UPDATE (immutable array update with spread)
- **IMPORTS**: No new imports needed
- **GOTCHA**: Must also remove the `new-turn-transcription` / `update-turn-answer` listeners in `disconnectedCallback`. Keep existing `new-response` / `update-response` listeners because local AI and cloud modes still use them.
- **VALIDATE**: Check that `chatTurns` updates trigger re-render. Verify `disconnectedCallback` cleans up all new listeners.

### Task 4: Pass `chatTurns` to `AssistantView`
- **ACTION**: In `CheatingDaddyApp.renderCurrentView()`, add `.chatTurns` prop to `<assistant-view>`. Also keep `.responses` and `.currentResponseIndex` for local/cloud fallback.
- **IMPLEMENT**:
  ```js
  case 'assistant':
      return html`
          <assistant-view
              .chatTurns=${this.chatTurns}
              .responses=${this.responses}
              .currentResponseIndex=${this.currentResponseIndex}
              .selectedProfile=${this.selectedProfile}
              .onSendText=${msg => this.handleSendText(msg)}
              .shouldAnimateResponse=${this.shouldAnimateResponse}
              @response-index-changed=${this.handleResponseIndexChanged}
              @response-animation-complete=${() => { ... }}
          ></assistant-view>
      `;
  ```
- **MIRROR**: LIT_COMPONENT_STRUCTURE
- **GOTCHA**: No change to existing props — additive only
- **VALIDATE**: AssistantView receives the prop (add `console.log` temporarily during dev)

### Task 5: Rewrite `AssistantView.js` — chat bubble layout
- **ACTION**: Add `chatTurns` static property. When `chatTurns` has items, render a scrolling chat list instead of the single-response container. Each turn has two bubbles: "Interviewer" (transcription) and "AI Answer" (streaming markdown). Keep the existing single-response layout as a fallback for when `chatTurns` is empty (local/cloud modes). Auto-scroll to bottom when new turns arrive.
- **IMPLEMENT**:
  ```js
  // New static property
  chatTurns: { type: Array },

  // In constructor:
  this.chatTurns = [];

  // New CSS (add to existing static styles):
  .chat-container {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
      scroll-behavior: smooth;
  }
  .turn { display: flex; flex-direction: column; gap: var(--space-sm); }
  .bubble-label {
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
  }
  .bubble {
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      line-height: var(--line-height);
      font-size: var(--font-size-base);
  }
  .bubble.interviewer {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-primary);
  }
  .bubble.answer {
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
      user-select: text;
      cursor: text;
  }
  .bubble.answer * { user-select: text; cursor: text; }
  .cursor-blink {
      display: inline-block;
      width: 2px;
      height: 1em;
      background: var(--accent);
      margin-left: 2px;
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  ```

  ```js
  // In render():
  const useChatMode = this.chatTurns && this.chatTurns.length > 0;

  if (useChatMode) {
      return html`
          <div class="chat-container" id="chatContainer">
              ${this.chatTurns.map(turn => html`
                  <div class="turn">
                      <div class="bubble-label">Interviewer</div>
                      <div class="bubble interviewer">${turn.transcription}</div>
                      ${turn.answer || turn.isAnswering ? html`
                          <div class="bubble-label">AI Answer</div>
                          <div class="bubble answer" .innerHTML=${this.renderMarkdown(turn.answer) + (turn.isAnswering && turn.answer.length > 0 ? '<span class="cursor-blink"></span>' : '')}></div>
                      ` : ''}
                  </div>
              `)}
          </div>
          ${this._renderInputBar()}
      `;
  }

  // Fallback (existing single response layout for local/cloud):
  return html`
      <div class="response-container" id="responseContainer"></div>
      ...
      ${this._renderInputBar()}
  `;
  ```
- **MIRROR**: LIT_COMPONENT_STRUCTURE, CSS_DESIGN_TOKENS
- **GOTCHA**: Lit's `.innerHTML` binding is fine for Markdown (the app already uses `innerHTML` via `updateResponseContent`). The `cursor-blink` span is appended to the rendered markdown string — works because `renderMarkdown` returns an HTML string. `isAnswering` is true while streaming; set it to false when the answer stops updating (handled by `handleUpdateTurnAnswer` in the app).
- **VALIDATE**: Chat bubbles appear. Interviewer label shows above transcription. AI Answer streams in with blinking cursor. Cursor disappears when streaming ends. Scroll works. Existing single-response view still works for local mode.

### Task 6: Auto-scroll to bottom on new turns
- **ACTION**: In `AssistantView.updated()`, when `chatTurns` changes, scroll the chat container to the bottom.
- **IMPLEMENT**:
  ```js
  updated(changedProperties) {
      super.updated(changedProperties);
      if (changedProperties.has('chatTurns')) {
          this._scrollChatToBottom();
      }
      // ... existing logic for responses, isAnalyzing ...
  }

  _scrollChatToBottom() {
      requestAnimationFrame(() => {
          const container = this.shadowRoot.querySelector('#chatContainer');
          if (container) {
              container.scrollTop = container.scrollHeight;
          }
      });
  }
  ```
- **MIRROR**: `scrollToBottom` method already in AssistantView (line 620-627) — same pattern
- **GOTCHA**: Use `requestAnimationFrame` not `setTimeout` to let Lit finish painting the new DOM before measuring `scrollHeight`
- **VALIDATE**: New turns always scroll into view automatically

### Task 7: Extract `_renderInputBar` helper in `AssistantView.js`
- **ACTION**: Extract the existing input bar HTML (type message + Analyze Screen button) into a `_renderInputBar()` method so it can be reused in both chat mode and single-response mode without duplication.
- **IMPLEMENT**:
  ```js
  _renderInputBar() {
      return html`
          <div class="input-bar">
              <div class="input-bar-inner">
                  <input
                      type="text"
                      id="textInput"
                      placeholder="Type a message..."
                      @keydown=${this.handleTextKeydown}
                  />
              </div>
              <button class="analyze-btn ${this.isAnalyzing ? 'analyzing' : ''}" @click=${this.handleScreenAnswer}>
                  <canvas class="analyze-canvas"></canvas>
                  <span class="analyze-btn-content">
                      <svg ...>...</svg>
                      Analyze Screen
                  </span>
              </button>
          </div>
      `;
  }
  ```
- **MIRROR**: LIT_COMPONENT_STRUCTURE
- **GOTCHA**: `id="textInput"` is accessed by `handleSendText` via `this.shadowRoot.querySelector('#textInput')` — keep the same id
- **VALIDATE**: Input bar renders identically in both modes. Sending a text message still works.

---

## Testing Strategy

### Manual Validation (no automated tests in this Electron/Lit project)

| Test | Steps | Expected |
|---|---|---|
| OpenAI-only transcription | Start session with only OpenAI key | Whisper VAD triggers, no Groq/Gemma calls |
| Chat turn appears | Say something audible during session | Interviewer bubble appears, then AI Answer streams in |
| Multiple turns | Say 3 questions | 3 turn pairs stack in scroll, auto-scrolls to latest |
| Manual text input | Type in text bar, press Enter | Text appears as Interviewer bubble, AI Answer streams |
| Analyze Screen button | Click during session | Existing behavior unchanged (single response, no chat turn) |
| Local AI mode | Start in local mode | Single-response layout used (no chatTurns), existing nav arrows work |
| Cloud mode | Start in cloud mode | Single-response layout used, existing behavior preserved |
| Session restart | Stop and start new session | Chat clears, chatTurns resets to [] |
| No OpenAI key | Session with only Gemini key | Gemini audio still connects; no Whisper VAD; no chat turns shown (empty chat shows "Listening..." placeholder) |

### Edge Cases Checklist
- [ ] Very short audio (<0.5s) — VAD filters it, no chat turn
- [ ] Whisper returns empty string — no turn emitted
- [ ] Network failure during OpenAI call — error logged, status updated, turn stays with empty answer
- [ ] Rapid successive questions — each gets unique turnIndex, no cross-contamination
- [ ] Session closed mid-stream — isAnswering stays true but irrelevant (view unmounts)

---

## Validation Commands

### Static Analysis
```bash
# No TypeScript in this project — plain JS with Electron
# Check for syntax errors:
node --check src/utils/gemini.js
node --check src/index.js
```
EXPECT: No errors printed

### Browser Validation
```bash
npm start
```
EXPECT:
1. App launches
2. Start session with OpenAI key configured
3. Speak — Interviewer bubble + AI Answer appear in chat
4. Multiple questions stack in scrolling chat
5. Analyze Screen button still shows response (chat doesn't break)

### Manual Validation Checklist
- [ ] Chat mode activates when OpenAI key is set
- [ ] Each detected utterance creates a new turn in the chat
- [ ] AI answer streams token by token with blinking cursor
- [ ] Cursor disappears when answer is complete
- [ ] Scroll auto-advances to latest turn
- [ ] Manual text input creates a turn (same as voice)
- [ ] Local AI mode shows single-response view (unchanged)
- [ ] Cloud mode shows single-response view (unchanged)
- [ ] Session restart clears the chat

---

## Acceptance Criteria
- [ ] All tasks completed
- [ ] Groq and Gemma are never invoked during a byok session with OpenAI key
- [ ] Every Whisper transcript appears as an Interviewer bubble
- [ ] AI answer streams into the Answer bubble with a typing cursor
- [ ] Chat auto-scrolls to the latest message
- [ ] Manual text message creates a chat turn
- [ ] Local mode and cloud mode single-response views are unaffected
- [ ] No console errors during normal operation

## Completion Checklist
- [ ] `currentTurnIndex` reset in `initializeNewSession`
- [ ] Groq dispatch block removed from Gemini `onmessage`
- [ ] `new-turn-transcription` and `update-turn-answer` IPC events used
- [ ] `CheatingDaddyApp` listeners cleaned up in `disconnectedCallback`
- [ ] `chatTurns` resets on session start
- [ ] `AssistantView` uses `chatTurns` for chat mode, falls back to existing for local/cloud
- [ ] Auto-scroll works via `requestAnimationFrame`
- [ ] No backward-compatibility hacks

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `turnIndex` mismatch between transcription and answer | Low | Medium | Use module-level counter incremented once in `transcribeAndRespond`, pass same value to `sendToOpenAI` |
| Lit `.innerHTML` binding XSS | Low | Low | Markdown is only from AI-generated text, not user-controlled external input |
| Auto-scroll fights user scroll position | Medium | Low | Only scroll when new turn is added; user can scroll up freely between turns |
| Existing `responses` / `new-response` paths break | Low | Medium | Keep all existing IPC listeners; chat mode is purely additive |

## Notes
- The Groq functions (`sendToGroq`, `sendToGemma`) can remain in `gemini.js` as dead code — they're not exported publicly and removing them risks breaking imports. They'll be unreachable but won't cause harm.
- `groqConversationHistory` array is reused by `sendToOpenAI` for context — rename is out of scope, leave as-is.
- Image analysis (`sendImageToGeminiHttp`) is unaffected — it goes through `new-response`/`update-response` which the existing single-response path (now fallback) still handles. This means a screenshot answer will NOT appear as a chat turn. That is acceptable for now.
- The `isAnswering` flag in `chatTurns` entries is set to `false` only when `handleUpdateTurnAnswer` is called (i.e., when a token arrives). A turn with `answer === ''` and `isAnswering === true` shows no Answer bubble, which is correct: the bubble should only appear once tokens start flowing.
