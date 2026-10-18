import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy*/waitFor default to 1 s, which flakes when the host is busy (a
// parallel build); the assertions themselves are unchanged.
configure({ asyncUtilTimeout: 5000 });

// The route lives in the URL hash, which persists across tests in one file: start every test at the root.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#");
});

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
