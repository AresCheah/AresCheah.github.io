// Page views (Home / Promo Video / Interactive Console / Technical Details), switched by the URL
// hash like the ATAS page; equations; copy button; video chapters.
(function () {
  const views = ["home", "promo-video", "console", "technical-details"];
  const sectionOf = {};          // in-page anchors of the technical page open that view first
  document.querySelectorAll("#technical-details [id]").forEach((el) => { sectionOf[el.id] = "technical-details"; });
  document.querySelectorAll("#home [id]").forEach((el) => { sectionOf[el.id] = "home"; });
  let current = null;

  function show(hash, scroll) {
    const id = (hash || "").replace(/^#/, "") || "home";
    const view = views.includes(id) ? id : (sectionOf[id] || "home");
    if (view !== current) {
      views.forEach((v) => { document.getElementById(v).hidden = v !== view; });
      document.querySelectorAll(".site-nav-links a").forEach((a) => {
        if (a.dataset.view === view) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      const promo = document.getElementById("promo");
      if (promo && view !== "promo-video") promo.pause();
      const hero = document.querySelector(".masthead video");
      if (hero) { if (view === "home") hero.play().catch(() => {}); else hero.pause(); }
      current = view;
      window.dispatchEvent(new CustomEvent("view:shown", { detail: view }));
    }
    if (scroll) {
      const el = views.includes(id) ? null : document.getElementById(id);
      if (el) el.scrollIntoView({ block: "start" });
      else window.scrollTo(0, 0);
    }
  }
  window.addEventListener("hashchange", () => show(location.hash, true));
  show(location.hash, true);

  // equations: inline $..$ in .m spans, display $$..$$ in .eq blocks
  function maths() {
    if (!window.katex) return;
    document.querySelectorAll(".m").forEach((el) => {
      try { window.katex.render(el.textContent, el, { throwOnError: false }); } catch (e) { /* keep the TeX */ }
    });
    if (window.renderMathInElement) {
      document.querySelectorAll(".eq").forEach((el) => window.renderMathInElement(el, {
        delimiters: [{ left: "$$", right: "$$", display: true }], throwOnError: false,
      }));
    }
  }
  maths();

  // copy BibTeX
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const src = document.querySelector(b.dataset.copy);
    const done = () => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(src.textContent).then(done, () => selectText(src));
    } else selectText(src);
  }));
  function selectText(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // promo chapters
  const promo = document.getElementById("promo");
  document.querySelectorAll(".chapters [data-t]").forEach((b) => b.addEventListener("click", () => {
    promo.currentTime = Number(b.dataset.t);
    promo.play().catch(() => {});
  }));
})();
