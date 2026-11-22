/**
 * dsh-browser-notify — Client 半边。
 *
 * 目标：DSH 完成 turn / agent 弹 ask_user_question 选择题时，由**浏览器**用
 * Web Notification API 弹桌面通知，点击跳回 DSH 页面。从你访问 3080 的浏览器发，
 * 不依赖 PowerShell / 系统通知后端。
 *
 * 触发源（订阅会话投影，纯 client）：
 *   1. `turnOutline` 投影新增一条 turn → 一次回应完成（`turn/end` 已 commit）。
 *   2. `userQuestions` 投影出现 active 行 → agent 提了 ask_user_question。
 *
 * 为什么用投影而不是原始 session/event：client 插件拿不到 Host 的
 * `session/event` 总线；client 的会话订阅面是 `sessions.list` + 每会话
 * `binding.session.projections.faceOf(...)`（见 user-questions client.js 的
 * reconcile 模式）。turnOutline/userQuestions 恰好覆盖两个触发点，且是
 * 浏览器已订阅的增量流。
 *
 * 权限：Notification API 需要 `Notification.requestPermission()`。用户首次
 * 授权一次后浏览器记住；未授权时本插件静默不发（不刷权限弹框，右下角状态条
 * 可手动触发授权）。
 *
 * 点击通知 → `notification.onclick` → `window.focus()` + 跳 `launchUrl`
 * （默认 `http://127.0.0.1:3080`，localStorage 可改）。
 *
 * 开关（localStorage `dsh.browser-notify.enabled`，默认开）+ 右下角状态条。
 * 页面不可见（`document.hidden`）时才弹，避免盯着页面时刷屏。
 */

window.__ModuleLoader__.load({
	id: 'dsh-browser-notify',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** localStorage keys. */
		const ENABLED_KEY = 'dsh.browser-notify.enabled';
		const LAUNCH_KEY = 'dsh.browser-notify.launchUrl';
		/** Default URL a notification click opens. */
		const DEFAULT_LAUNCH = 'http://127.0.0.1:3080';

		function readEnabled() {
			try {
				const raw = window.localStorage.getItem(ENABLED_KEY);
				if (raw === null) return true;
				return raw !== '0' && raw !== 'false';
			} catch (_error) {
				return true;
			}
		}

		function writeEnabled(next) {
			try { window.localStorage.setItem(ENABLED_KEY, next ? '1' : '0'); } catch (_error) { /* ignore */ }
		}

		function readLaunchUrl() {
			try {
				const raw = window.localStorage.getItem(LAUNCH_KEY);
				if (raw !== null && raw.trim().length > 0) return raw.trim();
			} catch (_error) { /* ignore */ }
			return DEFAULT_LAUNCH;
		}

		/** Can we show notifications right now? */
		function canNotify() {
			return typeof window.Notification === 'function' && window.Notification.permission === 'granted';
		}

		/** Fire one browser notification. Returns the Notification or null. */
		function notify(title, body) {
			if (!canNotify()) return null;
			const launch = readLaunchUrl();
			/** @type {NotificationOptions} */
			const options = {
				body,
				// Point the notification at the DSH origin so clicking it focuses a
				// tab of this origin when the browser supports it (Chrome focuses
				// an existing tab of the same origin instead of opening a new one).
				tag: 'dsh-browser-notify',
				requireInteraction: false,
				icon: undefined,
			};
			try {
				const n = new window.Notification(title, options);
				n.onclick = () => {
					try { window.focus(); } catch (_error) { /* ignore */ }
					try { window.location.href = launch; } catch (_error) { /* ignore */ }
					n.close();
				};
				// Auto-dismiss so completed-turn toasts don't pile up.
				setTimeout(() => { try { n.close(); } catch (_error) { /* ignore */ } }, 8000);
				return n;
			} catch (_error) {
				return null;
			}
		}

		/** Session label from a turnOutline entry. */
		function entryLabel(entry, sessionId) {
			const prompt = typeof entry?.prompt === 'string' && entry.prompt.trim().length > 0
				? entry.prompt.trim().slice(0, 60)
				: `回合 ${entry?.turn ?? '?'}`;
			return { title: `DSH · 回应完成`, body: prompt };
		}

		function ToggleChip({ permission }) {
			const [enabled, setEnabled] = React.useState(readEnabled);

			const toggle = React.useCallback((event) => {
				event.stopPropagation();
				setEnabled((current) => {
					const next = !current;
					writeEnabled(next);
					return next;
				});
			}, []);

			const requestPermission = React.useCallback((event) => {
				event.stopPropagation();
				if (typeof window.Notification !== 'function') return;
				window.Notification.requestPermission();
			}, []);

			const label = permission === 'granted'
				? (enabled ? '通知 · 开' : '通知 · 关')
				: '通知 · 未授权';
			const title = permission === 'granted'
				? (enabled ? '浏览器通知：已开启 · 点此关闭' : '浏览器通知：已关闭 · 点此开启')
				: '浏览器通知：点击授权桌面通知';

			return ReactDOM.createPortal(
				h('button', {
					type: 'button',
					'data-browser-notify-toggle': '',
					onClick: permission === 'granted' ? toggle : requestPermission,
					title,
					'aria-pressed': permission === 'granted' ? enabled : undefined,
					style: {
						position: 'fixed',
						right: '10px',
						bottom: '34px',
						zIndex: '8',
						appearance: 'none',
						border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
						borderRadius: '999px',
						background: enabled && permission === 'granted'
							? 'color-mix(in srgb, var(--dsw-alias-button-info-fill, #4d6bfe) 16%, transparent)'
							: 'transparent',
						color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
						font: 'inherit',
						fontSize: '10px',
						lineHeight: '16px',
						padding: '1px 8px',
						cursor: 'pointer',
						opacity: enabled ? '0.8' : '0.5',
					},
				}, label),
				document.body);
		}

		return {
			inject: ['sessions'],
			apply(ctx) {
				let chipHost = null;

				ctx.effect(() => {
					// Permission state drives the chip label / action.
					let permission = typeof window.Notification === 'function'
						? window.Notification.permission
						: 'unsupported';
					const renderChip = () => {
						if (chipHost === null) return;
						ReactDOM.render(h(ToggleChip, { permission }), chipHost);
					};

					chipHost = document.createElement('div');
					chipHost.dataset.browserNotify = '';
					document.body.appendChild(chipHost);
					renderChip();

					const sessions = ctx.sessions;
					/** Last known turn count per session, to detect a NEWLY completed turn. */
					const lastTurnCounts = new Map();
					/** Last known active question keys per session, to dedupe ask-user toasts. */
					const lastQuestionKeys = new Map();

					function maybeNotifyTurnEnd(sessionId, binding) {
						if (!readEnabled() || !canNotify()) return;
						// Only when the page is hidden: don't spam while the user is watching.
						if (document.hidden === false) return;
						const projected = binding.session.projections.faceOf('turnOutline').getSnapshot();
						const turns = Array.isArray(projected) ? projected : (projected?.turns ?? []);
						const count = turns.length;
						const previous = lastTurnCounts.get(sessionId);
						lastTurnCounts.set(sessionId, count);
						// Only fire when a turn was ADDED (count grew), never on first sight
						// of an existing session (previous === undefined) — that would toast
						// for every turn in history on page load.
						if (previous === undefined || count <= previous) return;
						const latest = turns[turns.length - 1];
						if (latest === undefined) return;
						const { title, body } = entryLabel(latest, sessionId);
						notify(title, body);
					}

					function maybeNotifyAskUser(sessionId, binding) {
						if (!readEnabled() || !canNotify()) return;
						if (document.hidden === false) return;
						const projected = binding.session.projections.faceOf('userQuestions').getSnapshot();
						const active = Array.isArray(projected?.active) ? projected.active : [];
						if (active.length === 0) { lastQuestionKeys.delete(sessionId); return; }
						/** One stable key per batch so re-renders don't re-toast. */
						const keys = active.map((row) => row.callId ?? row.key).sort().join(',');
						if (lastQuestionKeys.get(sessionId) === keys) return;
						const firstTime = !lastQuestionKeys.has(sessionId);
						lastQuestionKeys.set(sessionId, keys);
						// First sight of a session with an open question (page load) should
						// still notify — the user may have navigated away mid-question.
						if (firstTime && active.length === 0) return;
						notify('DSH · 需要你回答', 'agent 提了选择题，回到浏览器作答');
					}

					/**
					 * Subscribe to both projections for every bound session, mirroring the
					 * user-questions reconcile pattern (sessions.list + per-session bindings).
					 */
					const stopProjections = new Map();
					function reconcile() {
						const snapshot = sessions.list.getSnapshot();
						const bound = new Map(Object.values(snapshot.byId ?? {}).flatMap((summary) => {
							const binding = sessions.binding(summary.id);
							// list 与 binding 可能短暂不同步（新会话先上 list、binding 稍后就绪），
						// 或 binding 还没装配好 projections；此时跳过，等下一次 reconcile。
						if (binding?.session?.projections?.faceOf === undefined) return [];
						return [[summary.id, binding]];
						}));
						for (const [sessionId, stop] of stopProjections) {
							if (bound.has(sessionId)) continue;
							stop();
							stopProjections.delete(sessionId);
						}
						for (const [sessionId, binding] of bound) {
							if (stopProjections.has(sessionId)) continue;
							const onChange = () => {
								maybeNotifyTurnEnd(sessionId, binding);
								maybeNotifyAskUser(sessionId, binding);
							};
							const stopTurn = binding.session.projections.faceOf('turnOutline').subscribe(onChange);
							const stopQuestions = binding.session.projections.faceOf('userQuestions').subscribe(onChange);
							stopProjections.set(sessionId, () => { stopTurn(); stopQuestions(); });
							// Seed counts on first bind so history doesn't toast on load.
							const turnProjected = binding.session.projections.faceOf('turnOutline').getSnapshot();
							const turns = Array.isArray(turnProjected) ? turnProjected : (turnProjected?.turns ?? []);
							lastTurnCounts.set(sessionId, turns.length);
						}
					}

					reconcile();
					const stopList = sessions.list.subscribe(reconcile);

					return () => {
						stopList();
						for (const stop of stopProjections.values()) stop();
						stopProjections.clear();
						lastTurnCounts.clear();
						lastQuestionKeys.clear();
						if (chipHost !== null) {
							ReactDOM.unmountComponentAtNode(chipHost);
							chipHost.remove();
							chipHost = null;
						}
					};
				}, 'dsh-browser-notify: session projection observer');
			},
		};
	},
});