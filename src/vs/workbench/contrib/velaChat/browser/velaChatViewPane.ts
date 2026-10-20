/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/velaChat.css';
import { $, append, clearNode, EventHelper, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IVelaChatMessage, IVelaChatService, VelaChatError, VelaChatSettings } from '../common/velaChat.js';

/** One turn as it appears on screen; `text` grows while a reply streams in. */
interface ITurn {
	readonly role: 'user' | 'assistant';
	text: string;
	thoughts: string;
	/** Tool titles in the order the agent ran them, newest last. */
	readonly activity: string[];
	element?: HTMLElement;
	body?: HTMLElement;
	thoughtsElement?: HTMLElement;
	activityElement?: HTMLElement;
}

export class VelaChatViewPane extends ViewPane {

	static readonly ID = 'workbench.view.velaChat';

	private turns: ITurn[] = [];
	/** The agent session these turns belong to, so each turn continues the last. */
	private sessionId: string | undefined;
	private transcript!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private status!: HTMLElement;
	private sendButton!: Button;

	private readonly inFlight = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly renderStore = this._register(new DisposableStore());

	constructor(
		options: IViewletViewOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVelaChatService private readonly chatService: IVelaChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = append(container, $('.vela-chat'));
		this.transcript = append(root, $('.vela-chat-transcript'));
		this.transcript.setAttribute('role', 'log');
		this.transcript.setAttribute('aria-live', 'polite');
		this.transcript.setAttribute('aria-label', localize('velaChat.transcript', "Chat transcript"));

		this.renderEmptyState();

		const composer = append(root, $('.vela-chat-composer'));

		this.input = append(composer, $<HTMLTextAreaElement>('textarea.vela-chat-input'));
		this.input.placeholder = localize('velaChat.placeholder', "Ask about your code…");
		this.input.rows = 3;
		this.input.setAttribute('aria-label', localize('velaChat.inputLabel', "Chat message"));

		const actions = append(composer, $('.vela-chat-actions'));
		this.status = append(actions, $('span.vela-chat-status'));

		this.sendButton = this._register(new Button(actions, { ...defaultButtonStyles, title: localize('velaChat.sendTitle', "Send (Ctrl+Enter)") }));
		this.sendButton.label = localize('velaChat.send', "Send");
		this._register(this.sendButton.onDidClick(() => this.submit()));

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.input.focus();
			}
		}));

		this._register(this.registerInputKeys());
	}

	private registerInputKeys(): DisposableStore {
		const store = new DisposableStore();
		const listener = (event: KeyboardEvent) => {
			// Enter sends, Shift+Enter and Ctrl+Enter insert a newline, because a
			// question about code often needs more than one line.
			const sends = event.keyCode === KeyCode.Enter && !event.shiftKey && !event.ctrlKey && !event.metaKey;
			if (sends) {
				EventHelper.stop(event, true);
				this.submit();
				return;
			}
			if (event.keyCode === KeyCode.Escape && this.inFlight.value) {
				EventHelper.stop(event, true);
				this.cancel();
			}
		};
		this.input.addEventListener('keydown', listener);
		store.add({ dispose: () => this.input.removeEventListener('keydown', listener) });
		return store;
	}

	private async submit(): Promise<void> {
		if (this.inFlight.value) {
			return; // One reply at a time; Escape cancels the running one.
		}

		const text = this.input.value.trim();
		if (!text) {
			return;
		}

		this.input.value = '';
		this.addTurn({ role: 'user', text, thoughts: '', activity: [] });

		const reply: ITurn = { role: 'assistant', text: '', thoughts: '', activity: [] };
		this.addTurn(reply);

		const source = new CancellationTokenSource();
		this.inFlight.value = source;
		this.setBusy(true);

		try {
			const history: IVelaChatMessage[] = this.turns
				.filter(turn => turn !== reply && turn.text)
				.map(turn => ({ role: turn.role, content: turn.text }));

			for await (const chunk of this.chatService.chat({ messages: history, sessionId: this.sessionId }, source.token)) {
				switch (chunk.kind) {
					case 'text':
						reply.text += chunk.text;
						break;
					case 'thought':
						reply.thoughts += chunk.text;
						break;
					case 'tool':
						// A tool reports in_progress then completed; keep one line per call.
						if (chunk.title && reply.activity.at(-1) !== chunk.title) {
							reply.activity.push(chunk.title);
						}
						break;
					case 'permission':
						reply.activity.push(chunk.approved
							? localize('velaChat.allowed', "allowed {0}", chunk.title ?? '')
							: localize('velaChat.refused', "refused {0}", chunk.title ?? ''));
						break;
					case 'session':
						this.sessionId = chunk.sessionId;
						this.status.textContent = localize('velaChat.connected', "{0} · session open", chunk.agent ?? 'agent');
						break;
				}
				this.scheduleRender(reply);
			}

			if (!reply.text) {
				reply.text = localize('velaChat.empty', "_The agent finished without a reply._");
			}
		} catch (error) {
			reply.text = error instanceof VelaChatError
				? `**${error.message}**${error.detail ? `\n\n\`\`\`\n${error.detail}\n\`\`\`` : ''}`
				: localize('velaChat.failed', "**Something went wrong.** {0}", String(error));
			this.logService.error('[velaChat]', error);
		} finally {
			this.renderTurn(reply);
			this.inFlight.clear();
			this.setBusy(false);
			this.input.focus();
		}
	}

	private cancel(): void {
		this.inFlight.value?.cancel();
		this.inFlight.clear();
		this.setBusy(false);
	}

	private setBusy(busy: boolean): void {
		this.sendButton.enabled = !busy;
		this.status.textContent = busy ? localize('velaChat.thinking', "Thinking… press Escape to stop") : '';
	}

	private addTurn(turn: ITurn): void {
		if (!this.turns.length) {
			clearNode(this.transcript);
		}
		this.turns.push(turn);

		turn.element = append(this.transcript, $(`.vela-chat-turn.${turn.role}`));
		append(turn.element, $('.vela-chat-role', undefined, turn.role === 'user'
			? localize('velaChat.you', "You")
			: localize('velaChat.vela', "Vela")));
		if (turn.role === 'assistant') {
			turn.activityElement = append(turn.element, $('.vela-chat-activity'));
			turn.thoughtsElement = append(turn.element, $('.vela-chat-thoughts'));
		}
		turn.body = append(turn.element, $('.vela-chat-body'));

		this.renderTurn(turn);
		this.scrollToEnd();
	}

	private renderScheduled = false;

	/**
	 * Streaming can deliver many chunks per frame; re-rendering markdown on each
	 * one is wasted work, so coalesce them into one render per frame.
	 */
	private scheduleRender(turn: ITurn): void {
		if (this.renderScheduled) {
			return;
		}
		this.renderScheduled = true;
		this.renderStore.add(scheduleAtNextAnimationFrame(getWindow(this.transcript), () => {
			this.renderScheduled = false;
			this.renderTurn(turn);
			this.scrollToEnd();
		}));
	}

	private renderTurn(turn: ITurn): void {
		if (!turn.body) {
			return;
		}

		if (turn.activityElement) {
			clearNode(turn.activityElement);
			for (const entry of turn.activity) {
				append(turn.activityElement, $('.vela-chat-activity-item', undefined, entry));
			}
		}

		if (turn.thoughtsElement) {
			clearNode(turn.thoughtsElement);
			const show = this.configurationService.getValue<boolean>(VelaChatSettings.ShowThoughts);
			if (show && turn.thoughts) {
				append(turn.thoughtsElement, $('.vela-chat-thoughts-text', undefined, turn.thoughts));
			}
		}

		clearNode(turn.body);
		if (!turn.text) {
			return;
		}

		// Trusted is deliberately left off: replies are untrusted text, so no
		// command links or raw HTML from them. fillInIncompleteTokens closes the
		// fences and emphasis that a half-streamed reply always ends mid-way through.
		const rendered = renderMarkdown(new MarkdownString(turn.text), { fillInIncompleteTokens: true });
		this.renderStore.add(rendered);
		append(turn.body, rendered.element);
	}

	private renderEmptyState(): void {
		const empty = append(this.transcript, $('.vela-chat-empty'));
		append(empty, $('h3', undefined, localize('velaChat.welcomeTitle', "Vela Chat")));
		append(empty, $('p', undefined, localize('velaChat.welcomeBody', "Ask the agent to explain, change or run something. It works in this folder, and what it does appears above each reply.")));
	}

	private scrollToEnd(): void {
		this.transcript.scrollTop = this.transcript.scrollHeight;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.transcript.style.height = `${Math.max(0, height - this.input.offsetHeight - 56)}px`;
	}

	override focus(): void {
		super.focus();
		this.input?.focus();
	}
}
