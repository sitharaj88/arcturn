"use client";

import { useEffect } from "react";

/**
 * Publishes `data-scrolled` on `<html>` past 8px of scroll so the sticky
 * header can go from translucent to opaque in pure CSS. Rendering nothing
 * keeps the header itself a server component.
 */
export function ScrollState() {
  useEffect(() => {
    const root = document.documentElement;

    function update() {
      if (window.scrollY > 8) root.setAttribute("data-scrolled", "");
      else root.removeAttribute("data-scrolled");
    }

    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      root.removeAttribute("data-scrolled");
    };
  }, []);

  return null;
}
