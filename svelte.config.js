import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  // Not a SvelteKit project — Svelte 5 compiles `<script lang="ts">` natively.
  // This config exists so preprocessors (SCSS/PostCSS) have a home later.
  preprocess: vitePreprocess(),
};
