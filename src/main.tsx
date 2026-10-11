import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Audience } from "./Audience";
import "./index.css";

// La misma página sirve a las dos ventanas; la del público se abre con #audiencia.
const audience = window.location.hash === "#audiencia";

createRoot(document.getElementById("root")!).render(<StrictMode>{audience ? <Audience /> : <App />}</StrictMode>);
