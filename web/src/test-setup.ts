import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // localStorageが使えない環境では無視
  }
});
