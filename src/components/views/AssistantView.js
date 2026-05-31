import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class AssistantView extends LitElement {
    static styles = css`
        :host {
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        * {
            font-family: var(--font);
            cursor: default;
        }

        /* ── Chat mode ── */

        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: var(--space-md);
            display: flex;
            flex-direction: column;
            gap: var(--space-lg);
            scroll-behavior: smooth;
        }

        .chat-container::-webkit-scrollbar {
            width: 6px;
        }

        .chat-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .chat-container::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        .chat-container::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }

        .turn {
            display: flex;
            flex-direction: column;
            gap: var(--space-sm);
        }

        .bubble-label {
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-semibold);
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            padding: 0 var(--space-xs);
        }

        .bubble {
            padding: var(--space-sm) var(--space-md);
            border-radius: var(--radius-md);
            line-height: var(--line-height);
            font-size: var(--font-size-base);
            word-break: break-word;
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

        .bubble.answer * {
            user-select: text;
            cursor: text;
        }

        .bubble.answer a {
            cursor: pointer;
        }

        .bubble.answer.is-answering::after {
            content: '';
            display: inline-block;
            width: 2px;
            height: 1em;
            background: var(--accent);
            margin-left: 2px;
            vertical-align: text-bottom;
            animation: cursor-blink 1s step-end infinite;
        }

        @keyframes cursor-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
        }

        .chat-empty {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-muted);
            font-size: var(--font-size-sm);
        }

        /* ── Markdown styles for answer bubbles ── */

        .bubble.answer h1,
        .bubble.answer h2,
        .bubble.answer h3,
        .bubble.answer h4,
        .bubble.answer h5,
        .bubble.answer h6 {
            margin: 1em 0 0.5em 0;
            color: var(--text-primary);
            font-weight: var(--font-weight-semibold);
        }

        .bubble.answer h1 { font-size: 1.5em; }
        .bubble.answer h2 { font-size: 1.3em; }
        .bubble.answer h3 { font-size: 1.15em; }
        .bubble.answer h4 { font-size: 1.05em; }
        .bubble.answer h5,
        .bubble.answer h6 { font-size: 1em; }

        .bubble.answer p {
            margin: 0.6em 0;
        }

        .bubble.answer p:first-child {
            margin-top: 0;
        }

        .bubble.answer p:last-child {
            margin-bottom: 0;
        }

        .bubble.answer ul,
        .bubble.answer ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
        }

        .bubble.answer li {
            margin: 0.3em 0;
        }

        .bubble.answer blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid var(--border-strong);
            background: var(--bg-surface);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }

        .bubble.answer code {
            background: var(--bg-elevated);
            padding: 0.15em 0.4em;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.85em;
        }

        .bubble.answer pre {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            padding: var(--space-md);
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .bubble.answer pre code {
            background: none;
            padding: 0;
        }

        .bubble.answer a {
            color: var(--accent);
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .bubble.answer strong,
        .bubble.answer b {
            font-weight: var(--font-weight-semibold);
        }

        .bubble.answer hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 1.5em 0;
        }

        .bubble.answer table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .bubble.answer th,
        .bubble.answer td {
            border: 1px solid var(--border);
            padding: var(--space-sm);
            text-align: left;
        }

        .bubble.answer th {
            background: var(--bg-surface);
            font-weight: var(--font-weight-semibold);
        }

        /* ── Legacy single-response area (fallback for local/cloud) ── */

        .response-container {
            flex: 1;
            overflow-y: auto;
            font-size: var(--response-font-size, 15px);
            line-height: var(--line-height);
            background: var(--bg-app);
            padding: var(--space-sm) var(--space-md);
            scroll-behavior: smooth;
            user-select: text;
            cursor: text;
            color: var(--text-primary);
        }

        .response-container * {
            user-select: text;
            cursor: text;
        }

        .response-container a {
            cursor: pointer;
        }

        .response-container [data-word] {
            display: inline-block;
        }

        .response-container h1,
        .response-container h2,
        .response-container h3,
        .response-container h4,
        .response-container h5,
        .response-container h6 {
            margin: 1em 0 0.5em 0;
            color: var(--text-primary);
            font-weight: var(--font-weight-semibold);
        }

        .response-container h1 { font-size: 1.5em; }
        .response-container h2 { font-size: 1.3em; }
        .response-container h3 { font-size: 1.15em; }
        .response-container h4 { font-size: 1.05em; }
        .response-container h5,
        .response-container h6 { font-size: 1em; }

        .response-container p {
            margin: 0.6em 0;
            color: var(--text-primary);
        }

        .response-container ul,
        .response-container ol {
            margin: 0.6em 0;
            padding-left: 1.5em;
            color: var(--text-primary);
        }

        .response-container li {
            margin: 0.3em 0;
        }

        .response-container blockquote {
            margin: 0.8em 0;
            padding: 0.5em 1em;
            border-left: 2px solid var(--border-strong);
            background: var(--bg-surface);
            border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        }

        .response-container code {
            background: var(--bg-elevated);
            padding: 0.15em 0.4em;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: 0.85em;
        }

        .response-container pre {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            padding: var(--space-md);
            overflow-x: auto;
            margin: 0.8em 0;
        }

        .response-container pre code {
            background: none;
            padding: 0;
        }

        .response-container a {
            color: var(--accent);
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .response-container strong,
        .response-container b {
            font-weight: var(--font-weight-semibold);
        }

        .response-container hr {
            border: none;
            border-top: 1px solid var(--border);
            margin: 1.5em 0;
        }

        .response-container table {
            border-collapse: collapse;
            width: 100%;
            margin: 0.8em 0;
        }

        .response-container th,
        .response-container td {
            border: 1px solid var(--border);
            padding: var(--space-sm);
            text-align: left;
        }

        .response-container th {
            background: var(--bg-surface);
            font-weight: var(--font-weight-semibold);
        }

        .response-container::-webkit-scrollbar {
            width: 6px;
        }

        .response-container::-webkit-scrollbar-track {
            background: transparent;
        }

        .response-container::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        .response-container::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }

        /* ── Response navigation strip ── */

        .response-nav {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: var(--space-sm);
            padding: var(--space-xs) var(--space-md);
            border-top: 1px solid var(--border);
            background: var(--bg-app);
        }

        .nav-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            padding: var(--space-xs);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: color var(--transition);
        }

        .nav-btn:hover:not(:disabled) {
            color: var(--text-primary);
        }

        .nav-btn:disabled {
            opacity: 0.25;
            cursor: default;
        }

        .nav-btn svg {
            width: 14px;
            height: 14px;
        }

        .response-counter {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            font-family: var(--font-mono);
            min-width: 40px;
            text-align: center;
        }

        /* ── Bottom input bar ── */

        .input-bar {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-md);
            background: var(--bg-app);
        }

        .input-bar-inner {
            display: flex;
            align-items: center;
            flex: 1;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 100px;
            padding: 0 var(--space-md);
            height: 32px;
            transition: border-color var(--transition);
        }

        .input-bar-inner:focus-within {
            border-color: var(--accent);
        }

        .input-bar-inner input {
            flex: 1;
            background: none;
            color: var(--text-primary);
            border: none;
            padding: 0;
            font-size: var(--font-size-sm);
            font-family: var(--font);
            height: 100%;
            outline: none;
        }

        .input-bar-inner input::placeholder {
            color: var(--text-muted);
        }

        .analyze-btn {
            position: relative;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            color: var(--text-primary);
            cursor: pointer;
            font-size: var(--font-size-xs);
            font-family: var(--font-mono);
            white-space: nowrap;
            padding: var(--space-xs) var(--space-md);
            border-radius: 100px;
            height: 32px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: border-color 0.4s ease, background var(--transition);
            flex-shrink: 0;
            overflow: hidden;
        }

        .analyze-btn:hover:not(.analyzing) {
            border-color: var(--accent);
            background: var(--bg-surface);
        }

        .analyze-btn.analyzing {
            cursor: default;
            border-color: transparent;
        }

        .analyze-btn-content {
            display: flex;
            align-items: center;
            gap: 4px;
            transition: opacity 0.4s ease;
            z-index: 1;
            position: relative;
        }

        .analyze-btn.analyzing .analyze-btn-content {
            opacity: 0;
        }

        .analyze-canvas {
            position: absolute;
            inset: -1px;
            width: calc(100% + 2px);
            height: calc(100% + 2px);
            pointer-events: none;
        }
    `;

    static properties = {
        chatTurns: { type: Array },
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        selectedProfile: { type: String },
        onSendText: { type: Function },
        shouldAnimateResponse: { type: Boolean },
        isAnalyzing: { type: Boolean, state: true },
    };

    constructor() {
        super();
        this.chatTurns = [];
        this.responses = [];
        this.currentResponseIndex = -1;
        this.selectedProfile = 'interview';
        this.onSendText = () => {};
        this.isAnalyzing = false;
        this._animFrame = null;
    }

    getProfileNames() {
        return {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
    }

    getCurrentResponse() {
        const profileNames = this.getProfileNames();
        return this.responses.length > 0 && this.currentResponseIndex >= 0
            ? this.responses[this.currentResponseIndex]
            : `Listening to your ${profileNames[this.selectedProfile] || 'session'}...`;
    }

    renderMarkdown(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({
                    breaks: true,
                    gfm: true,
                    sanitize: false,
                });
                return window.marked.parse(content);
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content;
            }
        }
        return content;
    }

    renderMarkdownWithWordSpans(content) {
        if (typeof window !== 'undefined' && window.marked) {
            try {
                window.marked.setOptions({ breaks: true, gfm: true, sanitize: false });
                let rendered = window.marked.parse(content);
                rendered = this.wrapWordsInSpans(rendered);
                return rendered;
            } catch (error) {
                console.warn('Error parsing markdown:', error);
                return content;
            }
        }
        return content;
    }

    wrapWordsInSpans(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const tagsToSkip = ['PRE'];

        function wrap(node) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() && !tagsToSkip.includes(node.parentNode.tagName)) {
                const words = node.textContent.split(/(\s+)/);
                const frag = document.createDocumentFragment();
                words.forEach(word => {
                    if (word.trim()) {
                        const span = document.createElement('span');
                        span.setAttribute('data-word', '');
                        span.textContent = word;
                        frag.appendChild(span);
                    } else {
                        frag.appendChild(document.createTextNode(word));
                    }
                });
                node.parentNode.replaceChild(frag, node);
            } else if (node.nodeType === Node.ELEMENT_NODE && !tagsToSkip.includes(node.tagName)) {
                Array.from(node.childNodes).forEach(wrap);
            }
        }
        Array.from(doc.body.childNodes).forEach(wrap);
        return doc.body.innerHTML;
    }

    navigateToPreviousResponse() {
        if (this.currentResponseIndex > 0) {
            this.currentResponseIndex--;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    navigateToNextResponse() {
        if (this.currentResponseIndex < this.responses.length - 1) {
            this.currentResponseIndex++;
            this.dispatchEvent(
                new CustomEvent('response-index-changed', {
                    detail: { index: this.currentResponseIndex },
                })
            );
            this.requestUpdate();
        }
    }

    scrollResponseUp() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.max(0, container.scrollTop - scrollAmount);
        }
    }

    scrollResponseDown() {
        const container = this.shadowRoot.querySelector('.response-container');
        if (container) {
            const scrollAmount = container.clientHeight * 0.3;
            container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + scrollAmount);
        }
    }

    _scrollChatToBottom() {
        requestAnimationFrame(() => {
            const container = this.shadowRoot.querySelector('#chatContainer');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        });
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            this.handlePreviousResponse = () => this.navigateToPreviousResponse();
            this.handleNextResponse = () => this.navigateToNextResponse();
            this.handleScrollUp = () => this.scrollResponseUp();
            this.handleScrollDown = () => this.scrollResponseDown();

            ipcRenderer.on('navigate-previous-response', this.handlePreviousResponse);
            ipcRenderer.on('navigate-next-response', this.handleNextResponse);
            ipcRenderer.on('scroll-response-up', this.handleScrollUp);
            ipcRenderer.on('scroll-response-down', this.handleScrollDown);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopWaveformAnimation();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            if (this.handlePreviousResponse) ipcRenderer.removeListener('navigate-previous-response', this.handlePreviousResponse);
            if (this.handleNextResponse) ipcRenderer.removeListener('navigate-next-response', this.handleNextResponse);
            if (this.handleScrollUp) ipcRenderer.removeListener('scroll-response-up', this.handleScrollUp);
            if (this.handleScrollDown) ipcRenderer.removeListener('scroll-response-down', this.handleScrollDown);
        }
    }

    async handleSendText() {
        const textInput = this.shadowRoot.querySelector('#textInput');
        if (textInput && textInput.value.trim()) {
            const message = textInput.value.trim();
            textInput.value = '';
            await this.onSendText(message);
        }
    }

    handleTextKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.handleSendText();
        }
    }

    async handleScreenAnswer() {
        if (this.isAnalyzing) return;
        if (window.captureManualScreenshot) {
            this.isAnalyzing = true;
            this._responseCountWhenStarted = this.responses.length;
            window.captureManualScreenshot();
        }
    }

    _startWaveformAnimation() {
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);

        const dangerColor = getComputedStyle(this).getPropertyValue('--danger').trim() || '#EF4444';
        const startTime = performance.now();
        const FADE_IN = 0.5;
        const PARTICLE_SPREAD = 4;
        const PARTICLE_COUNT = 250;

        const w = rect.width;
        const h = rect.height;
        const r = h / 2;
        const straightLen = w - 2 * r;
        const arcLen = Math.PI * r;
        const perimeter = 2 * straightLen + 2 * arcLen;

        const pointOnPerimeter = (d) => {
            d = ((d % perimeter) + perimeter) % perimeter;
            if (d < straightLen) {
                return { x: r + d, y: 0, nx: 0, ny: 1 };
            }
            d -= straightLen;
            if (d < arcLen) {
                const angle = -Math.PI / 2 + (d / arcLen) * Math.PI;
                return {
                    x: w - r + Math.cos(angle) * r,
                    y: r + Math.sin(angle) * r,
                    nx: -Math.cos(angle),
                    ny: -Math.sin(angle),
                };
            }
            d -= arcLen;
            if (d < straightLen) {
                return { x: w - r - d, y: h, nx: 0, ny: -1 };
            }
            d -= straightLen;
            const angle = Math.PI / 2 + (d / arcLen) * Math.PI;
            return {
                x: r + Math.cos(angle) * r,
                y: r + Math.sin(angle) * r,
                nx: -Math.cos(angle),
                ny: -Math.sin(angle),
            };
        };

        const seeds = [];
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            seeds.push({ pos: Math.random(), drift: Math.random(), depthSeed: Math.random() });
        }

        const draw = (now) => {
            const elapsed = (now - startTime) / 1000;
            const fade = Math.min(1, elapsed / FADE_IN);

            ctx.clearRect(0, 0, w, h);

            ctx.fillStyle = dangerColor;
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const s = seeds[i];
                const along = (s.pos + s.drift * elapsed * 0.03) * perimeter;
                const depth = s.depthSeed * PARTICLE_SPREAD;
                const density = 1 - depth / PARTICLE_SPREAD;

                if (Math.random() > density) continue;

                const p = pointOnPerimeter(along);
                const px = p.x + p.nx * depth;
                const py = p.y + p.ny * depth;
                const size = 0.8 + density * 0.6;

                ctx.globalAlpha = fade * density * 0.85;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }

            const midY = h / 2;
            const waves = [
                { freq: 3, amp: 0.35, speed: 2.5, opacity: 0.9, width: 1.8 },
                { freq: 5, amp: 0.2, speed: 3.5, opacity: 0.5, width: 1.2 },
                { freq: 7, amp: 0.12, speed: 5, opacity: 0.3, width: 0.8 },
            ];

            for (const wave of waves) {
                ctx.beginPath();
                ctx.strokeStyle = dangerColor;
                ctx.globalAlpha = wave.opacity * fade;
                ctx.lineWidth = wave.width;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                for (let x = 0; x <= w; x++) {
                    const norm = x / w;
                    const envelope = Math.sin(norm * Math.PI);
                    const y = midY + Math.sin(norm * Math.PI * 2 * wave.freq + elapsed * wave.speed) * (midY * wave.amp) * envelope;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
            this._animFrame = requestAnimationFrame(draw);
        };

        this._animFrame = requestAnimationFrame(draw);
    }

    _stopWaveformAnimation() {
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
        const canvas = this.shadowRoot.querySelector('.analyze-canvas');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.response-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }

    firstUpdated() {
        super.firstUpdated();
        this.updateResponseContent();
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('chatTurns')) {
            this._scrollChatToBottom();
        }

        if (changedProperties.has('responses') || changedProperties.has('currentResponseIndex')) {
            this.updateResponseContent();
        }

        if (changedProperties.has('isAnalyzing')) {
            if (this.isAnalyzing) {
                this._startWaveformAnimation();
            } else {
                this._stopWaveformAnimation();
            }
        }

        if (changedProperties.has('responses') && this.isAnalyzing) {
            if (this.responses.length > this._responseCountWhenStarted) {
                this.isAnalyzing = false;
            }
        }
    }

    updateResponseContent() {
        const container = this.shadowRoot.querySelector('#responseContainer');
        if (container) {
            const currentResponse = this.getCurrentResponse();
            const renderedResponse = this.renderMarkdownWithWordSpans(currentResponse);
            container.innerHTML = renderedResponse;
            if (this.shouldAnimateResponse) {
                this.dispatchEvent(new CustomEvent('response-animation-complete', { bubbles: true, composed: true }));
            }
        }
    }

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
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
                            <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 3v7h6l-8 11v-7H5z" />
                        </svg>
                        Analyze Screen
                    </span>
                </button>
            </div>
        `;
    }

    _renderChatMode() {
        return html`
            <div class="chat-container" id="chatContainer">
                ${this.chatTurns.length === 0 ? html`
                    <div class="chat-empty">Listening...</div>
                ` : this.chatTurns.map(turn => html`
                    <div class="turn">
                        <div class="bubble-label">Interviewer</div>
                        <div class="bubble interviewer">${turn.transcription}</div>
                        ${turn.answer || turn.isAnswering ? html`
                            <div class="bubble-label">AI Answer</div>
                            <div
                                class="bubble answer ${turn.isAnswering ? 'is-answering' : ''}"
                                data-turn-index="${turn.turnIndex}"
                                .innerHTML=${this.renderMarkdown(turn.answer || '')}
                            ></div>
                        ` : ''}
                    </div>
                `)}
            </div>
            ${this._renderInputBar()}
        `;
    }

    _renderSingleResponseMode() {
        const hasMultipleResponses = this.responses.length > 1;

        return html`
            <div class="response-container" id="responseContainer"></div>

            ${hasMultipleResponses ? html`
                <div class="response-nav">
                    <button class="nav-btn" @click=${this.navigateToPreviousResponse} ?disabled=${this.currentResponseIndex <= 0} title="Previous response">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" />
                        </svg>
                    </button>
                    <span class="response-counter">${this.currentResponseIndex + 1} of ${this.responses.length}</span>
                    <button class="nav-btn" @click=${this.navigateToNextResponse} ?disabled=${this.currentResponseIndex >= this.responses.length - 1} title="Next response">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            ` : ''}

            ${this._renderInputBar()}
        `;
    }

    render() {
        const useChatMode = this.chatTurns && this.chatTurns.length > 0;

        if (useChatMode) {
            return this._renderChatMode();
        }

        return this._renderSingleResponseMode();
    }
}

customElements.define('assistant-view', AssistantView);
