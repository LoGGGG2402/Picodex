export function installBootstrapMobileSidebarModule(args: {
  mobileSidebarMediaQuery: string;
  dispatchHostMessage: (message: unknown) => void;
  isPrimaryUnmodifiedClick: (event: MouseEvent) => boolean;
}): {
  installMobileSidebarThreadNavigationClose: () => void;
  isMobileSidebarViewport: () => boolean;
} {
  const { mobileSidebarMediaQuery, dispatchHostMessage, isPrimaryUnmodifiedClick } = args;

  function installMobileSidebarThreadNavigationClose(): void {
    document.addEventListener("click", handleMobileSidebarThreadClick, true);
    document.addEventListener("click", handleMobileContentPaneClick, true);
  }

  function handleMobileSidebarThreadClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const navigation = target.closest('nav[role="navigation"]');
    if (!navigation) {
      return;
    }

    const nearestInteractive = target.closest(
      'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
    );
    if (!nearestInteractive || !navigation.contains(nearestInteractive)) {
      return;
    }

    if (
      isMobileSidebarThreadRow(nearestInteractive) ||
      isMobileSidebarNewThreadTrigger(nearestInteractive)
    ) {
      scheduleMobileSidebarClose();
    }
  }

  function isMobileSidebarThreadRow(element: Element): boolean {
    if (
      element.tagName === "BUTTON" ||
      element.getAttribute("role") !== "button" ||
      !element.closest('nav[role="navigation"]')
    ) {
      return false;
    }

    if (element.querySelector("[data-thread-title]")) {
      return true;
    }

    if (!element.closest('[role="listitem"]')) {
      return false;
    }

    const buttons = element.querySelectorAll("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index);
      const ariaLabel = button?.getAttribute("aria-label");
      if (ariaLabel === "Archive thread" || ariaLabel === "Unarchive thread") {
        return true;
      }
    }

    return false;
  }

  function isMobileSidebarNewThreadTrigger(element: Element): boolean {
    if (
      !element.closest('nav[role="navigation"]') ||
      (element.tagName !== "BUTTON" && element.tagName !== "A")
    ) {
      return false;
    }

    const ariaLabel = element.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (ariaLabel === "new thread" || ariaLabel.startsWith("start new thread in ")) {
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() ?? "";
    return text === "new thread";
  }

  function handleMobileContentPaneClick(event: MouseEvent): void {
    if (!isMobileSidebarViewport() || !isPrimaryUnmodifiedClick(event)) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest('nav[role="navigation"]') || !target.closest(".main-surface")) {
      return;
    }

    if (!isMobileSidebarOpen()) {
      return;
    }

    scheduleMobileSidebarClose();
  }

  function scheduleMobileSidebarClose(): void {
    window.setTimeout(() => {
      if (isMobileSidebarViewport() && isMobileSidebarOpen()) {
        dispatchHostMessage({ type: "toggle-sidebar" });
      }
    }, 0);
  }

  function isMobileSidebarOpen(): boolean {
    const contentPane = document.querySelector(".main-surface");
    if (!(contentPane instanceof Element)) {
      return false;
    }

    const style = (
      contentPane as Element & {
        style?: { width?: string; transform?: string };
      }
    ).style;
    const width = typeof style?.width === "string" ? style.width.trim() : "";
    if (width !== "" && width !== "100%") {
      return true;
    }

    const transform = typeof style?.transform === "string" ? style.transform.trim() : "";
    if (transform !== "" && transform !== "translateX(0)" && transform !== "translateX(0px)") {
      return true;
    }

    return isMobileSidebarOpenByGeometry(contentPane);
  }

  function isMobileSidebarOpenByGeometry(contentPane: Element): boolean {
    if (typeof contentPane.getBoundingClientRect !== "function") {
      return false;
    }

    const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 0;
    const rect = contentPane.getBoundingClientRect();
    if (rect.left > 0.5) {
      return true;
    }

    if (viewportWidth > 0 && rect.width > 0 && rect.width < viewportWidth - 0.5) {
      return true;
    }

    const navigation = document.querySelector('nav[role="navigation"]');
    if (
      !(navigation instanceof Element) ||
      typeof navigation.getBoundingClientRect !== "function"
    ) {
      return false;
    }

    const navigationRect = navigation.getBoundingClientRect();
    return navigationRect.left >= -0.5 && navigationRect.right > 0.5 && navigationRect.width > 0.5;
  }

  function isMobileSidebarViewport(): boolean {
    if (typeof window.matchMedia === "function") {
      return window.matchMedia(mobileSidebarMediaQuery).matches;
    }
    return window.innerWidth <= 640;
  }

  return {
    installMobileSidebarThreadNavigationClose,
    isMobileSidebarViewport,
  };
}
