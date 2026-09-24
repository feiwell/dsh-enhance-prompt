window.__ModuleLoader__.load({
	id: "@local/dsh-enhance-prompt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsxRuntime = require("react/jsx-runtime");
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const css = ".dshEnhance_row{align-items:center;display:inline-flex;gap:4px}.dshEnhance_mode{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-fg-secondary,currentColor);cursor:pointer;display:inline-flex;font:inherit;font-size:12px;gap:2px;height:28px;line-height:18px;max-width:96px;padding:0 6px}.dshEnhance_mode:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-fg-primary,currentColor)}.dshEnhance_mode:focus-visible,.dshEnhance_button:focus-visible{outline:2px solid var(--dsw-alias-border-focus,currentColor);outline-offset:2px}.dshEnhance_mode:disabled{cursor:default;opacity:.45}.dshEnhance_modeLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshEnhance_chevron{display:inline-flex;flex:none}.dshEnhance_button{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-fg-secondary,currentColor);cursor:pointer;display:inline-flex;height:28px;justify-content:center;padding:0;width:28px}.dshEnhance_button:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-fg-primary,currentColor)}.dshEnhance_button:disabled{cursor:default;opacity:.45}.dshEnhance_button_revert{color:var(--dsw-alias-brand-primary,currentColor)}.dshEnhance_spin{animation:dshEnhanceSpin 1s linear infinite;display:inline-flex;transform-origin:center}@keyframes dshEnhanceSpin{to{transform:rotate(360deg)}}";
		const tagId = "@local/dsh-enhance-prompt/button.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-enhance-prompt";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const MODES = [
			{ id: "work", label: "日常办公" },
			{ id: "code", label: "代码开发" },
			{ id: "design", label: "设计创意" },
		];

		function UndoIcon() {
			return jsxRuntime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: "15",
				height: "15",
				"aria-hidden": true,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: jsxRuntime.jsx("path", { d: "M3.2 7.2h7.1a3.2 3.2 0 1 1 0 6.4H8M3.2 7.2L5.8 4.6M3.2 7.2l2.6 2.6" }),
			});
		}

		/**
		 * Composer control on conversation.input.right. The draft and setDraft
		 * arrive as the session's standard input props; the rewrite itself is
		 * this plugin's POST /api/enhance-prompt, so nothing is patched into the
		 * shipped conversation bundle.
		 */
		function EnhancePromptButton({ useInput, inputActions }) {
			const draft = useInput((state) => state?.draft ?? "");
			const phaseState = useInput((state) => state?.phase ?? "plain");
			const [mode, setMode] = react.useState("work");
			const [menuOpen, setMenuOpen] = react.useState(false);
			const [phase, setPhase] = react.useState("idle");
			const [backup, setBackup] = react.useState(null);
			const [error, setError] = react.useState(null);
			const requestRef = react.useRef(0);
			const anchorRef = react.useRef(null);
			const text = draft.trim();
			const frozen = phaseState === "adjudicating" || phaseState === "submitting";
			const revertMode = phase === "done" && backup !== null && draft === backup.after;
			const busy = phase === "loading";
			const disabled = frozen || busy || (!revertMode && text.length === 0);
			const label = error ? error : busy ? "增强中…" : revertMode ? "恢复原文" : text.length === 0 ? "先输入内容，再增强提示词" : "增强提示词";
			const modeLabel = (MODES.find((item) => item.id === mode) ?? MODES[0]).label;

			const onClick = () => {
				if (inputActions === void 0 || frozen || busy) return;
				if (revertMode) {
					inputActions.setDraft(backup.before);
					setBackup(null);
					setPhase("idle");
					setError(null);
					return;
				}
				if (text.length === 0) return;
				const before = draft;
				const request = requestRef.current + 1;
				requestRef.current = request;
				setPhase("loading");
				setError(null);
				const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 30_000);
				fetch("/api/enhance-prompt", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ input: before, mode }),
					signal: controller.signal,
				}).then((response) => response.json().then((body) => ({ ok: response.ok, body }))).then(({ ok, body }) => {
					if (requestRef.current !== request) return;
					const enhanced = typeof body?.text === "string" ? body.text.trim() : "";
					if (!ok || enhanced.length === 0) {
						setError(typeof body?.error === "string" ? body.error : "增强失败");
						setPhase("idle");
						return;
					}
					setBackup({ before, after: enhanced });
					inputActions.setDraft(enhanced);
					setPhase("done");
				}, (reason) => {
					if (requestRef.current !== request) return;
					setError(reason instanceof Error && reason.name === "AbortError" ? "增强超时" : reason instanceof Error ? reason.message : "增强失败");
					setPhase("idle");
				}).finally(() => {
					clearTimeout(timer);
				});
			};

			return jsxRuntime.jsxs("span", {
				className: "dshEnhance_row",
				children: [
					jsxRuntime.jsx(primitives.Menu, {
						open: menuOpen,
						items: MODES,
						selectedId: mode,
						onSelect: (id) => {
							setMode(id);
							setMenuOpen(false);
						},
						onClose: () => setMenuOpen(false),
						side: "top",
						anchor: jsxRuntime.jsxs("button", {
							ref: anchorRef,
							type: "button",
							className: "dshEnhance_mode",
							disabled: frozen || busy,
							title: "增强模式：" + modeLabel,
							"aria-label": "增强模式：" + modeLabel,
							"aria-haspopup": "menu",
							"aria-expanded": menuOpen,
							onMouseDown: (event) => event.preventDefault(),
							onClick: () => setMenuOpen((open) => !open),
							children: [
								jsxRuntime.jsx("span", { className: "dshEnhance_modeLabel", children: modeLabel }),
								jsxRuntime.jsx("span", {
									className: "dshEnhance_chevron",
									"aria-hidden": true,
									children: jsxRuntime.jsx(primitives.IconChevronDownOutline14, {}),
								}),
							],
						}),
					}),
					jsxRuntime.jsx("button", {
						type: "button",
						className: "dshEnhance_button" + (revertMode ? " dshEnhance_button_revert" : ""),
						title: label,
						"aria-label": label,
						disabled,
						onMouseDown: (event) => event.preventDefault(),
						onClick,
						children: revertMode
							? jsxRuntime.jsx(UndoIcon, {})
							: jsxRuntime.jsx("span", {
								className: busy ? "dshEnhance_spin" : void 0,
								style: { display: "inline-flex" },
								children: jsxRuntime.jsx(primitives.IconEditOutline16, { size: 14 }),
							}),
					}),
				],
			});
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "enhance-prompt",
				order: 10,
			}, EnhancePromptButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
