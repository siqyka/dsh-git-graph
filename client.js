window.__ModuleLoader__.load({
	id: "dsh-git-graph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region styles
		const css = [
			".gg-action{box-sizing:border-box;height:34px;min-width:0;flex:1;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary, #8b949e);border-radius:8px;align-items:center;gap:8px;padding:0 10px;font-size:13px;line-height:20px;display:inline-flex;overflow:hidden}",
			".gg-action:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));color:var(--dsw-alias-label-primary, #e6edf3)}",
			".gg-action.gg-active{color:var(--dsw-alias-label-primary, #e6edf3);background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));border-color:var(--dsw-alias-border-l2, rgba(128,128,128,.35))}",
			".gg-action svg{flex:none}",
			".gg-actionLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			/* frame shared by dock panel and conversation tab */
			".gg-frame{flex:1;width:100%;border:0;display:block;background:#0d1117;min-height:0}",
			/* conversation view (tab) */
			".gg-view{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base, #0d1117)}",
			".gg-view .gg-frame{flex:1}",
			/* dock panel (real right column) */
			".gg-dockPanel{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base, #0d1117)}",
			".gg-dockPanel .gg-dockHead{flex:none;height:40px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1, #30363d);background:var(--dsw-alias-bg-elevated, #12171f);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary, #e6edf3)}",
			".gg-dockPanel .gg-dockTitle{display:flex;align-items:center;gap:7px;min-width:0}",
			".gg-dockPanel .gg-spacer{flex:1}",
			".gg-dockPanel .gg-frame{flex:1}",
			/* generic head buttons (close) */
			".gg-close{flex:none;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary, #8b949e);cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}",
			".gg-close:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));color:var(--dsw-alias-label-primary, #e6edf3)}"
		].join("");
		const tagId = "dsh-git-graph/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-git-graph";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region tiny open-state store shared by button and panel
		let open = false;
		const listeners = new Set();
		function setOpen(v) {
			if (open === v) return;
			open = v;
			listeners.forEach((fn) => fn(open));
		}
		function useOpen() {
			const [value, setValue] = react.useState(open);
			react.useEffect(() => {
				const fn = () => setValue(open);
				listeners.add(fn);
				return () => { listeners.delete(fn); };
			}, []);
			return value;
		}
		//#endregion

		const GitGlyph = () => react_jsx_runtime.jsx("svg", {
			width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true,
			children: react_jsx_runtime.jsxs("g", {
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round",
				children: [
					react_jsx_runtime.jsx("circle", { cx: 3.5, cy: 3.5, r: 1.8 }),
					react_jsx_runtime.jsx("circle", { cx: 3.5, cy: 12.5, r: 1.8 }),
					react_jsx_runtime.jsx("circle", { cx: 12.5, cy: 7.5, r: 1.8 }),
					react_jsx_runtime.jsx("path", { d: "M3.5 5.3v5.4M3.5 10.7C5 9.2 7 8.2 10.7 7.9" })
				]
			})
		});

		/** Sidebar footer action button (list slot `sidebar.footer.action`): toggles the dock panel. */
		function GitGraphButton(props) {
			const isOpen = useOpen();
			return react_jsx_runtime.jsx("button", {
				type: "button",
				className: "gg-action" + (isOpen ? " gg-active" : ""),
				title: "Git 图谱（停靠到右侧栏）",
				"aria-label": "Git 图谱",
				onClick: () => {
					if (window.__ggDock && window.__ggDock.isDocked()) window.__ggDock.dockOut();
					else window.__ggDock && window.__ggDock.dockIn();
				},
				children: react_jsx_runtime.jsxs(react.Fragment, {
					children: [
						react_jsx_runtime.jsx(GitGlyph, {}),
						props.wide && react_jsx_runtime.jsx("span", { className: "gg-actionLabel", children: "Git 图谱" })
					]
				})
			});
		}

		const graphSrc = (sid) => "/git-graph/index.html" + (sid ? "?sid=" + encodeURIComponent(sid) : "");

		/** Conversation view tab: the graph embedded in the session pane. */
		function GitGraphView(props) {
			const sid = props.sessionId || "";
			return react_jsx_runtime.jsx("div", {
				className: "gg-view",
				children: react_jsx_runtime.jsx("iframe", {
					className: "gg-frame",
					src: graphSrc(sid),
					title: "Git 图谱"
				})
			});
		}

		/** Dock panel: rendered inside the DSH right details column (real split view). */
		function GitGraphDock(props) {
			const sid = props.sessionId || "";
			react.useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") window.__ggDock?.dockOut(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, []);
			return react_jsx_runtime.jsx("div", {
				className: "gg-dockPanel",
				children: react_jsx_runtime.jsxs(react.Fragment, {
					children: [
						react_jsx_runtime.jsx("div", {
							className: "gg-dockHead",
							children: react_jsx_runtime.jsxs(react.Fragment, {
								children: [
									react_jsx_runtime.jsx(GitGlyph, {}),
									react_jsx_runtime.jsx("span", { className: "gg-dockTitle", children: "Git 图谱" }),
									react_jsx_runtime.jsx("span", { className: "gg-headHint", children: "右键菜单 · 拖栏边调宽" }),
									react_jsx_runtime.jsx("span", { className: "gg-spacer" }),
									react_jsx_runtime.jsx("button", {
										type: "button",
										className: "gg-close",
										title: "关闭停靠",
										"aria-label": "关闭停靠",
										onClick: () => window.__ggDock?.dockOut(),
										children: "✕"
									})
								]
							})
						}),
						react_jsx_runtime.jsx("iframe", {
							className: "gg-frame",
							src: graphSrc(sid),
							title: "Git 图谱"
						})
					]
				})
			});
		}

		/** Required services: the slot registry and the layout (details panel control). */
		const inject = ["slots", "layout"];

		/** Client plugin body: sidebar button (toggles dock), dock panel, and conversation tab. */
		function apply(ctx) {
			// Real dock into the right details column: dynamic registration so the
			// shipped session-details panel comes back when the dock closes.
			let dockDisposer = null;
			const dockIn = () => {
				if (dockDisposer) return;
				try {
					// priority -1 shadows the shipped session-details panel (same-priority
					// registrations conflict; lowest priority wins for single slots).
					dockDisposer = ctx.slots.register({
						name: "details",
						id: "git-graph-dock",
						priority: -1
					}, GitGraphDock);
					ctx.layout.openDetails();
					setOpen(true);
				} catch (e) {
					dockDisposer = null;
				}
			};
			const dockOut = () => {
				if (dockDisposer) {
					dockDisposer();
					dockDisposer = null;
				}
				try { ctx.layout.closeDetails(); } catch { /* ignore */ }
				setOpen(false);
			};
			window.__ggDock = {
				dockIn,
				dockOut,
				isDocked: () => !!dockDisposer
			};
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "git-graph",
				order: 20
			}, GitGraphButton));
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "git-graph",
				order: 20,
				label: () => "Git 图谱"
			}, GitGraphView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
