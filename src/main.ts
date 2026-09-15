import { mount } from "svelte";
import App from "./App.svelte";

// Imported outside any component, so it stays a plain global stylesheet —
// which the tab shell and the imperatively-built DOM (match banner, cells,
// cards) both rely on. See the notes in styles.css.
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

const app = mount(App, { target });

export default app;
