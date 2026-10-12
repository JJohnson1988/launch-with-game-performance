import { definePlugin, Field, TextField, IconsModule } from '@steambrew/client';
import React, { useState, useEffect } from 'react';

// Plugin state tracking
let hooksInjected = false;

// Plugin configuration with defaults
let pluginConfig = {
	globalLaunchOptions: '',
	excludedGameIds: ''
};

const plugin = {
	prefix: '%cGlobal Launch Options%c',
	style: 'color: #cdd6f4; background-color: #746292; padding: 2px 4px; border-radius: 3px;',

	log(...args) {
		console.log(plugin.prefix, plugin.style, '', ...args);
	},

	warn(...args) {
		console.warn(plugin.prefix, plugin.style, '', ...args);
	},

	error(...args) {
		console.error(plugin.prefix, plugin.style, '', ...args);
	},
};

/**
 * Gets the current configuration from memory
 */
function getCurrentConfig() {
	return pluginConfig;
}

/**
 * Retrieves current launch options for a specific Steam app safely with resolution guards
 */
async function getCurrentLaunchOptions(appId) {
	return new Promise((resolve, reject) => {
		let isResolved = false;
		const numericAppId = parseInt(appId);

		const unregister = window.SteamClient.Apps.RegisterForAppDetails(numericAppId, (appDetails) => {
			if (isResolved) return;
			isResolved = true;
			try {
				const launchOptions = appDetails.strLaunchOptions || '';
				unregister.unregister();
				resolve(launchOptions);
			} catch (error) {
				unregister.unregister();
				reject(error);
			}
		});

		setTimeout(() => {
			if (isResolved) return;
			isResolved = true;
			unregister.unregister();
			reject(new Error(`Timeout waiting for app details for app ${appId}`));
		}, 5000);
	});
}

/**
 * Quote-aware argument tokenizer for Linux shell strings.
 * Preserves single and double quotes so spaces inside scripts/arguments don't break them.
 */
function tokenizeArgs(input) {
	const tokens = [];
	let current = '';
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\') {
			escaped = true;
			current += char;
			continue;
		}
		if (char === '\'' && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += char;
			continue;
		}
		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += char;
			continue;
		}
		if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
			if (current.trim().length > 0) {
				tokens.push(current.trim());
				current = '';
			}
			continue;
		}
		current += char;
	}
	if (current.trim().length > 0) {
		tokens.push(current.trim());
	}
	return tokens;
}

/**
 * Parses launch options string into structured components using quote-aware tokenization.
 */
function parseLaunchOptions(options) {
	if (!options.trim()) {
		return { envVars: [], preArgs: [], postCommand: [], hasCommand: false };
	}

	const parts = options.split('%command%');

	const classifyPreCommand = (preStr) => {
		const tokens = tokenizeArgs(preStr);
		const envVars = [];
		const preArgs = [];

		for (const token of tokens) {
			// Top-level environment variable assignment (must not be enclosed in quotes)
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !token.startsWith("'") && !token.startsWith('"')) {
				envVars.push(token);
			} else {
				preArgs.push(token);
			}
		}
		return { envVars, preArgs };
	};

	if (parts.length === 1) {
		return {
			envVars: [],
			preArgs: [],
			postCommand: tokenizeArgs(parts[0]),
			hasCommand: false
		};
	} else {
		const preStr = parts[0];
		const postStr = parts.slice(1).join('%command%');
		
		const pre = classifyPreCommand(preStr);
		const postCommand = tokenizeArgs(postStr);

		return {
			envVars: pre.envVars,
			preArgs: pre.preArgs,
			postCommand,
			hasCommand: true
		};
	}
}

/**
 * Intelligently merges original app launch options with global launch options,
 * ensuring Linux environment variables come first, followed by wrappers/shell code,
 * followed by %command% and game-specific post-commands.
 */
function mergeLaunchOptions(originalOptions, globalOptions) {
	const original = parseLaunchOptions(originalOptions);
	const global = parseLaunchOptions(globalOptions);

	const deduplicateArray = (arr) => {
		const seen = new Set();
		return arr.filter(item => {
			if (seen.has(item)) return false;
			seen.add(item);
			return true;
		});
	};

	const combinedEnvVars = deduplicateArray([...global.envVars, ...original.envVars]);
	const combinedPreArgs = deduplicateArray([...global.preArgs, ...original.preArgs]);
	const combinedPostCommand = deduplicateArray([...original.postCommand, ...global.postCommand]);

	let resultParts = [];

	// 1. Environment variables MUST come first on Linux
	if (combinedEnvVars.length > 0) {
		resultParts.push(combinedEnvVars.join(' '));
	}

	// 2. Wrappers, binaries, and shell options come next
	if (combinedPreArgs.length > 0) {
		resultParts.push(combinedPreArgs.join(' '));
	}

	// 3. Include %command% placeholder if present or needed
	if (original.hasCommand || global.hasCommand || resultParts.length > 0) {
		resultParts.push('%command%');
	}

	// 4. Game-specific post-command arguments
	if (combinedPostCommand.length > 0) {
		resultParts.push(combinedPostCommand.join(' '));
	}

	return resultParts.join(' ');
}

/**
 * Injects hooks into Steam's game launch process using action-ID mapping
 */
function injectLaunchHooks() {
	if (hooksInjected) return;
	plugin.log('Injecting robust launch hooks...');

	const activeLaunches = new Map();

	const restoreLaunchOptions = (gameActionId) => {
		const launch = activeLaunches.get(gameActionId);
		if (!launch) return;

		clearTimeout(launch.timeoutId);
		try {
			window.SteamClient.Apps.SetAppLaunchOptions(
				parseInt(launch.appId),
				launch.originalOptions
			);
			plugin.log(`Restored launch options for app ${launch.appId} (Action ID: ${gameActionId})`);
		} catch (e) {
			plugin.error(`Failed to restore launch options for app ${launch.appId}:`, e);
		} finally {
			activeLaunches.delete(gameActionId);
		}
	};

	if (window.SteamClient?.Apps?.RegisterForGameActionEnd) {
		window.SteamClient.Apps.RegisterForGameActionEnd((gameActionId) => {
			if (gameActionId !== undefined && activeLaunches.has(gameActionId)) {
				restoreLaunchOptions(gameActionId);
			} else {
				for (const [id] of activeLaunches.entries()) {
					restoreLaunchOptions(id);
				}
			}
		});
		plugin.log('Registered for GameActionEnd events');
	} else {
		plugin.error('RegisterForGameActionEnd API not available');
	}

	if (window.SteamClient?.Apps?.RegisterForGameActionUserRequest) {
		window.SteamClient.Apps.RegisterForGameActionUserRequest((gameActionId, appId, action) => {
			if (action !== 'LaunchApp') return;

			const config = getCurrentConfig();
			const excludedAppIds = config.excludedGameIds
				? config.excludedGameIds.split(',').map((id) => id.trim())
				: [];

			if (excludedAppIds.includes(appId.toString())) {
				plugin.log(`App ${appId} is excluded from global launch options.`);
				return;
			}

			activeLaunches.set(gameActionId, {
				appId: appId.toString(),
				originalOptions: '',
				timeoutId: 0
			});
			plugin.log(`Tracked launch intent for app ${appId} (Action ID: ${gameActionId})`);
		});
		plugin.log('Registered for GameActionUserRequest events');
	} else {
		plugin.error('RegisterForGameActionUserRequest API not available');
	}

	if (window.SteamClient?.Apps?.ContinueGameAction) {
		const originalContinueGameAction = window.SteamClient.Apps.ContinueGameAction;
		window.SteamClient.Apps.ContinueGameAction = async function (gameActionId, action) {
			if (action === 'CreatingProcess' && activeLaunches.has(gameActionId)) {
				const launch = activeLaunches.get(gameActionId);
				const config = getCurrentConfig();

				if (config.globalLaunchOptions) {
					try {
						launch.originalOptions = await getCurrentLaunchOptions(launch.appId);
						plugin.log(`Original launch options for app ${launch.appId}: "${launch.originalOptions}"`);

						const mergedOptions = mergeLaunchOptions(launch.originalOptions, config.globalLaunchOptions);
						plugin.log(`Launching with merged options: "${mergedOptions}"`);

						window.SteamClient.Apps.SetAppLaunchOptions(
							parseInt(launch.appId),
							mergedOptions
						);

						launch.timeoutId = window.setTimeout(() => {
							plugin.warn(`Restore timeout reached for app ${launch.appId}, forcing restore.`);
							restoreLaunchOptions(gameActionId);
						}, 30000);

					} catch (e) {
						plugin.error('Error processing launch options during process creation:', e);
						activeLaunches.delete(gameActionId);
					}
				} else {
					plugin.log('No global options configured.');
					activeLaunches.delete(gameActionId);
				}
			}

			return originalContinueGameAction.call(this, gameActionId, action);
		};
		plugin.log('Hooked ContinueGameAction successfully');
	}

	hooksInjected = true;
	plugin.log('Launch hooks injected successfully.');
}

/**
 * Settings component for the in-steam config UI
 */
const SingleSetting = (props) => {
	const [textValue, setTextValue] = useState('');

	const saveConfig = () => {
		localStorage.setItem("global_launch_options.config", JSON.stringify(pluginConfig));
		plugin.log('Configuration saved:', pluginConfig);
	};

	useEffect(() => {
		if (props.type === "text") {
			setTextValue(pluginConfig[props.name]);
		}
	}, []);

	if (props.type === "text") {
		return React.createElement(Field, { 
			label: props.label, 
			description: props.description, 
			bottomSeparator: "standard", 
			focusable: true 
		}, React.createElement(TextField, { 
			value: textValue, 
			onChange: (e) => { 
				const value = e.currentTarget.value;
				setTextValue(value);
				pluginConfig[props.name] = value; 
				saveConfig(); 
			} 
		}));
	}
	return null;
};

const SettingsContent = () => {
	return React.createElement(React.Fragment, null,
		React.createElement("style", null, `
			.DialogInput_Wrapper._DialogLayout.Panel {
				width: 100%;
				max-width: 400px;
			}
			div:has(> .DialogInput_Wrapper._DialogLayout.Panel) {
				justify-content: flex-end;
			}
			.global-launch-options-settings > div > div > div:nth-child(1) {
				flex-grow: 0 !important;
			}
			.global-launch-options-settings > div > div > div:nth-child(2) {
				flex-grow: 1;
			}
		`),
		React.createElement("div", { className: "global-launch-options-settings", style: { padding: '8px 0' } },
			React.createElement(SingleSetting, { 
				name: "globalLaunchOptions", 
				type: "text", 
				label: "Global Launch Options", 
				description: "Launch options applied globally (e.g., MANGOHUD=1 bash -c 'export FOO=bar; %command%'). Use %command% as the executable placeholder." 
			}),
			React.createElement(SingleSetting, { 
				name: "excludedGameIds", 
				type: "text", 
				label: "Excluded Game IDs", 
				description: "Comma-separated list of Steam App IDs to exclude from global launch options (e.g., 570,730,440)" 
			})
		)
	);
};

/**
 * Millennium plugin entry point
 */
export default definePlugin(() => {
	plugin.log('Global Launch Options plugin initializing...');
	
	const storedConfig = JSON.parse(localStorage.getItem("global_launch_options.config") || "{}");
	pluginConfig = { ...pluginConfig, ...storedConfig };
	plugin.log('Loaded config:', pluginConfig);
	
	setTimeout(injectLaunchHooks, 500);
	
	plugin.log('Plugin initialization complete');

	return {
		title: "Global Launch Options",
		icon: React.createElement(IconsModule.Settings, null),
		content: React.createElement(SettingsContent, null),
	};
});
