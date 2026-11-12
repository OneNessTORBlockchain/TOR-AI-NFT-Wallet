import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./tor/ui";
import { ChainGuardProvider } from "./tor/security";
import { WalletProvider } from "./tor/wallet";
import App from "./App";
import "./tor/styles.css";
import "./tor/charts.css";
import "./tor/accent.css";

/*
 * Provider order matters: the chain guard needs the toast channel to announce a
 * failed binding, and the wallet sits *inside* the guard because a wallet action
 * may only run when the guard says the chain is the pinned one.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ChainGuardProvider>
        <WalletProvider>
          <App />
        </WalletProvider>
      </ChainGuardProvider>
    </ToastProvider>
  </StrictMode>,
);
