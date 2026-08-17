window.__ModuleLoader__.load({
	id: "dsh-plugin-mobile-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:/Users/hongbo/dsh/plugins/packages/mobile-shell/src/client/NarrowShell.module.css.mjs
		const css$1 = ".cgxxIa_hamburger{z-index:40;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:34px;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;pointer-events:auto;border-radius:9px;justify-content:center;align-items:center;display:flex;position:absolute;top:8px;left:8px}.cgxxIa_hamburger:hover{background:var(--dsw-alias-interactive-bg-hover)}.cgxxIa_scrim{z-index:35;background:var(--dsw-alias-bg-mask-1);pointer-events:auto;position:absolute;inset:0}";
		const tagId$1 = "dsh-plugin-mobile-shell/NarrowShell.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-mobile-shell";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var NarrowShell_module_css_default = {
			"hamburger": "cgxxIa_hamburger",
			"scrim": "cgxxIa_scrim"
		};
		//#endregion
		//#region src/client/NarrowShell.tsx
		/**
		* Narrow-viewport affordances: a hamburger, a scrim, swipe-to-open/close, and
		* "tapping a group keeps the drawer open".
		*
		* All of it lives in the shell overlay layer and drives the sidebar through
		* `ctx.layout.toggleSidebar()`. Nothing here patches the layout package; the
		* drawer geometry is a stylesheet keyed on the shell's own data attributes.
		*/
		/** Fallback width, used until the host answers and if it never does. */
		const NARROW_MAX_WIDTH = 1023;
		/** Minimum horizontal travel, and how much it must beat vertical travel by. */
		const SWIPE_MIN_PX = 50;
		const SWIPE_AXIS_RATIO = 1.5;
		/** Find the AppFrame element: the parent of the overlay layer. */
		function frameElement() {
			return document.querySelector("[data-shell-overlay]")?.parentElement ?? null;
		}
		/**
		* Whether the sidebar is showing.
		*
		* The shell writes `data-sidebar-collapsed` from a boolean prop, and React
		* omits the attribute entirely when it is false — so "open" is the absence of
		* the attribute, never the string "false".
		* @returns true when the drawer is open.
		*/
		function isDrawerOpen() {
			const frame = frameElement();
			return frame !== null && frame.dataset.sidebarCollapsed !== "true";
		}
		/** Render the narrow-viewport controls; nothing at all on a wide viewport. */
		function NarrowShell({ toggleSidebar, loadSettings, t }) {
			const [narrowMaxWidth, setNarrowMaxWidth] = (0, react.useState)(NARROW_MAX_WIDTH);
			const [titleTemplate, setTitleTemplate] = (0, react.useState)("");
			const [narrow, setNarrow] = (0, react.useState)(() => window.innerWidth <= NARROW_MAX_WIDTH);
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				loadSettings().then((settings) => {
					if (cancelled) return;
					setNarrowMaxWidth(settings.narrowMaxWidth);
					setTitleTemplate(settings.documentTitle);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [loadSettings]);
			(0, react.useEffect)(() => {
				const frame = frameElement();
				if (frame === null) return;
				if (narrow) frame.setAttribute("data-mobile-shell-narrow", "");
				else frame.removeAttribute("data-mobile-shell-narrow");
				return () => {
					frame.removeAttribute("data-mobile-shell-narrow");
				};
			}, [narrow]);
			(0, react.useEffect)(() => {
				if (titleTemplate === "") return;
				const titleElement = document.querySelector("title");
				if (titleElement === null) return;
				const previous = document.title;
				const pin = () => {
					const wanted = titleTemplate.replaceAll("{host}", window.location.hostname);
					if (document.title !== wanted) document.title = wanted;
				};
				pin();
				const observer = new MutationObserver(pin);
				observer.observe(titleElement, {
					childList: true,
					characterData: true,
					subtree: true
				});
				return () => {
					observer.disconnect();
					document.title = previous;
				};
			}, [titleTemplate]);
			(0, react.useEffect)(() => {
				const frame = frameElement();
				if (frame === null) return;
				const sync = () => {
					setOpen(isDrawerOpen());
				};
				sync();
				const observer = new MutationObserver(sync);
				observer.observe(frame, {
					attributes: true,
					attributeFilter: ["data-sidebar-collapsed"]
				});
				return () => {
					observer.disconnect();
				};
			}, [narrow]);
			(0, react.useEffect)(() => {
				const frame = frameElement();
				if (frame === null) return;
				const update = () => {
					const width = frame.clientWidth;
					if (width === 0) return;
					setNarrow(width <= narrowMaxWidth);
				};
				update();
				const observer = new ResizeObserver(update);
				observer.observe(frame);
				window.addEventListener("resize", update);
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", update);
				};
			}, [narrowMaxWidth]);
			(0, react.useEffect)(() => {
				if (!narrow) return;
				let start = null;
				const onStart = (event) => {
					const touch = event.touches[0];
					start = touch === void 0 ? null : {
						x: touch.clientX,
						y: touch.clientY
					};
				};
				const onEnd = (event) => {
					const touch = event.changedTouches[0];
					if (start === null || touch === void 0) return;
					const dx = touch.clientX - start.x;
					const dy = touch.clientY - start.y;
					start = null;
					if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;
					if (dx > 0 !== isDrawerOpen()) toggleSidebar();
				};
				document.addEventListener("touchstart", onStart, { passive: true });
				document.addEventListener("touchend", onEnd, { passive: true });
				return () => {
					document.removeEventListener("touchstart", onStart);
					document.removeEventListener("touchend", onEnd);
				};
			}, [narrow, toggleSidebar]);
			(0, react.useEffect)(() => {
				if (!narrow) return;
				const onClick = (event) => {
					if (!isDrawerOpen()) return;
					const target = event.target;
					if (!(target instanceof Element)) return;
					const row = target.closest("[role=\"treeitem\"], [role=\"option\"]");
					if (row === null || row.hasAttribute("aria-expanded")) return;
					toggleSidebar();
				};
				document.addEventListener("click", onClick, true);
				return () => {
					document.removeEventListener("click", onClick, true);
				};
			}, [narrow, toggleSidebar]);
			if (!narrow) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: NarrowShell_module_css_default.hamburger,
				"aria-label": open ? t("closeNav") : t("openNav"),
				"aria-expanded": open,
				onClick: () => {
					toggleSidebar();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "17",
					height: "17",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "2",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 7h16M4 12h16M4 17h16" })
				})
			}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: NarrowShell_module_css_default.scrim,
				onClick: () => {
					toggleSidebar();
				}
			}) : null] });
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy dictionaries for the narrow-viewport shell. */
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			openNav: "打开导航菜单",
			closeNav: "关闭导航菜单"
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			openNav: "Open navigation menu",
			closeNav: "Close navigation menu"
		};
		//#endregion
		//#region \0dsh-css:/Users/hongbo/dsh/plugins/packages/mobile-shell/src/client/narrow-shell.css.mjs
		const css = "[data-mobile-shell-narrow]{grid-template-columns:minmax(0,1fr)!important}[data-mobile-shell-narrow]>:first-child{z-index:36;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:78%;max-width:380px;transition:transform .25s;position:absolute;top:0;bottom:0;left:0;transform:translate(-102%)}[data-mobile-shell-narrow]:not([data-sidebar-collapsed=true])>:first-child{transform:translate(0)}[data-mobile-shell-narrow]>:nth-child(2){padding-top:34px}@media (prefers-reduced-motion:reduce){[data-mobile-shell-narrow]>:first-child{transition:none}}";
		const tagId = "dsh-plugin-mobile-shell/narrow-shell.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-mobile-shell";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		/** Dictionary namespace owned by this plugin. */
		const NS = "mobileShell";
		const FALLBACK = {
			narrowMaxWidth: NARROW_MAX_WIDTH,
			documentTitle: "DSH · {host}"
		};
		/** Ask the host for its settings; its own defaults stand in if it cannot answer. */
		async function fetchShellConfig() {
			try {
				const response = await fetch("/plugins/mobile-shell/config");
				if (!response.ok) return FALLBACK;
				const body = await response.json();
				return {
					narrowMaxWidth: typeof body.narrowMaxWidth === "number" ? body.narrowMaxWidth : FALLBACK.narrowMaxWidth,
					documentTitle: typeof body.documentTitle === "string" ? body.documentTitle : FALLBACK.documentTitle
				};
			} catch {
				return FALLBACK;
			}
		}
		/** Services required by the registration below. */
		const inject = [
			"slots",
			"locale",
			"layout"
		];
		/** Seat the narrow-viewport controls; the component fetches its own settings. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "mobile-shell: dictionaries");
			const injected = () => ({
				toggleSidebar: () => {
					ctx.layout.toggleSidebar();
				},
				loadSettings: fetchShellConfig
			});
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "mobile-shell",
				order: 10,
				locale: NS,
				inject: injected
			}, NarrowShell));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map