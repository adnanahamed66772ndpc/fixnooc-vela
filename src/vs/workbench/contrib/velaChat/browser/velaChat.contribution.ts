/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IVelaChatService, VELA_CHAT_CONTAINER_ID, VELA_CHAT_VIEW_ID, VelaChatSettings } from '../common/velaChat.js';
import { VelaChatService } from './velaChatService.js';
import { VelaChatViewPane } from './velaChatViewPane.js';

registerSingleton(IVelaChatService, VelaChatService, InstantiationType.Delayed);

const velaChatIcon = registerIcon('vela-chat-view-icon', Codicon.commentDiscussion, localize('velaChatViewIcon', 'View icon of the Vela Chat view.'));

const VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: VELA_CHAT_CONTAINER_ID,
	title: localize2('velaChat.container', "Vela Chat"),
	icon: velaChatIcon,
	order: 20,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VELA_CHAT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: `${VELA_CHAT_CONTAINER_ID}.state`,
	hideIfEmpty: false,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: VELA_CHAT_VIEW_ID,
	name: localize2('velaChat.view', "Vela Chat"),
	containerIcon: velaChatIcon,
	ctorDescriptor: new SyncDescriptor(VelaChatViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: 'workbench.action.velaChat.open',
		mnemonicTitle: localize({ key: 'miVelaChat', comment: ['&& denotes a mnemonic'] }, "Vela &&Chat"),
		keybindings: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyI) },
		order: 1,
	},
}], VIEW_CONTAINER);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'velaChat',
	title: localize('velaChat.configuration', "Vela Chat"),
	type: 'object',
	properties: {
		[VelaChatSettings.Backend]: {
			type: 'string',
			default: 'dsh',
			enum: ['dsh', 'openai'],
			enumDescriptions: [
				localize('velaChat.backend.dsh', "Drive DeepSeek Harness as an agent: it can read, change and run things in the workspace."),
				localize('velaChat.backend.openai', "Send the conversation to an OpenAI-compatible completions endpoint, which only replies with text."),
			],
			markdownDescription: localize('velaChat.backend.description', "Which backend answers. Leave `#velaChat.endpoint#` empty to use each backend's default path."),
			scope: ConfigurationScope.APPLICATION,
		},
		[VelaChatSettings.ReasoningEffort]: {
			type: 'string',
			default: '',
			enum: ['', 'off', 'low', 'high', 'max'],
			enumDescriptions: [
				localize('velaChat.effort.default', "Leave the agent's own default in place."),
				localize('velaChat.effort.off', "No reasoning; for simple tasks."),
				localize('velaChat.effort.low', "For routine or latency-sensitive tasks."),
				localize('velaChat.effort.high', "The usual balance."),
				localize('velaChat.effort.max', "For the hardest tasks, at the cost of speed."),
			],
			markdownDescription: localize('velaChat.effort.description', "How hard the agent should think. Applies to the `dsh` backend only."),
			scope: ConfigurationScope.APPLICATION,
		},
		[VelaChatSettings.ShowThoughts]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('velaChat.showThoughts.description', "Show the agent's reasoning above each reply. Applies to the `dsh` backend only."),
			scope: ConfigurationScope.APPLICATION,
		},
		[VelaChatSettings.Endpoint]: {
			type: 'string',
			default: '',
			markdownDescription: localize('velaChat.endpoint.description', "Where turns are sent. Empty uses the chosen backend's default path, which is relative so it reaches whatever serves Vela and the API key stays there instead of in the browser."),
			scope: ConfigurationScope.APPLICATION,
		},
		[VelaChatSettings.Model]: {
			type: 'string',
			default: '',
			markdownDescription: localize('velaChat.model.description', "Model to use for every request. Leave empty to let the endpoint choose one to match how much work the request is."),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});
