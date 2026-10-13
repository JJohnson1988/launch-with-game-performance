import { definePlugin } from '@steambrew/client';

let hooked = false;

const plugin = {
	prefix: '%cLaunch with game-performance tool%c',
	style: 'color: #cdd6f4; background-color: #746292; padding: 2px 4px; border-radius: 3px;',
	log(...args: any[]): void {
		console.log(plugin.prefix, plugin.style, '', ...args);
	},
	error(...args: any[]): void {
		console.error(plugin.prefix, plugin.style, '', ...args);
	},
};

const merge = (opt = '') => {
	const t = opt.trim();
	if (!t) return 'game-performance %command%';
	if (t.includes('game-performance')) return t;

	// Split options into discrete whitespace-separated tokens
	const tokens = t.split(/\s+/);
	const envVars: string[] = [];
	let i = 0;

	// Automatically scoop up any leading assignment tokens (containing '=')
	while (i < tokens.length && tokens[i].includes('=') && !tokens[i].includes('%command%')) {
		envVars.push(tokens[i]);
		i++;
	}

	const restTokens = tokens.slice(i);
	const rest = restTokens.length > 0 ? restTokens.join(' ') : '%command%';
	const target = rest.includes('%command%') ? rest : `${rest} %command%`;

	// If environment variables were found, explicitly prepend 'env' and place them first
	if (envVars.length > 0) {
		return `env ${envVars.join(' ')} game-performance ${target}`;
	}

	return `game-performance ${target}`;
};

async function getCurrentLaunchOptions(appId: string): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			const numericAppId = parseInt(appId);
			const unregister = window.SteamClient.Apps.RegisterForAppDetails(numericAppId, (appDetails) => {
				try {
					const launchOptions = appDetails?.strLaunchOptions ?? '';
					unregister.unregister();
					resolve(launchOptions);
				} catch (error) {
					unregister.unregister();
					reject(error);
				}
			});

			setTimeout(() => {
				unregister.unregister();
				reject(new Error(`Timeout waiting for app details for app ${appId}`));
			}, 5000);
		} catch (error) {
			reject(error);
		}
	});
}

export default definePlugin(() => {
	if (hooked) return;
	hooked = true;

	// Startup crash recovery sweep
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k?.startsWith('gp_crash_')) {
			const id = k.replace('gp_crash_', '');
			const savedOptions = localStorage.getItem(k);
			if (savedOptions !== null && savedOptions !== undefined) {
				window.SteamClient?.Apps?.SetAppLaunchOptions?.(parseInt(id), savedOptions);
			}
			localStorage.removeItem(k);
		}
	}

	const launches = new Map();

	window.SteamClient?.Apps?.RegisterForGameActionUserRequest?.((id, appId, action) => {
		if (action === 'LaunchApp') {
			launches.set(id, { appId: appId.toString(), original: null });
		}
	});

	if (window.SteamClient?.Apps?.ContinueGameAction) {
		const orig = window.SteamClient.Apps.ContinueGameAction;
		window.SteamClient.Apps.ContinueGameAction = async function (id, action) {
			if (action === 'CreatingProcess' && launches.has(id)) {
				const l = launches.get(id);
				try {
					const appIdNum = parseInt(l.appId);
					const original = await getCurrentLaunchOptions(l.appId);
					l.original = original;

					// Save backup for crash recovery
					localStorage.setItem(`gp_crash_${l.appId}`, l.original);

					// Merge options cleanly using token parsing
					const mergedOptions = merge(l.original);
					plugin.log('Applied launch command:', mergedOptions);

					// 1. Temporarily apply wrapper so Steam spawns the process with it
					window.SteamClient.Apps.SetAppLaunchOptions(appIdNum, mergedOptions);

					// Let Steam create the process
					const result = await orig.call(this, id, action);

					// 2. Instantly restore original clean options to Steam config (500ms later)
					setTimeout(() => {
						try {
							window.SteamClient.Apps.SetAppLaunchOptions(appIdNum, l.original);
							localStorage.removeItem(`gp_crash_${l.appId}`);
						} catch (e) {
							plugin.error('Failed to restore clean launch options:', e);
						} finally {
							launches.delete(id);
						}
					}, 500);

					return result;
				} catch (e) {
					plugin.error('Failed to process launch options:', e);
					launches.delete(id);
				}
			}
			return orig.call(this, id, action);
		};
	}

	return {};
});
