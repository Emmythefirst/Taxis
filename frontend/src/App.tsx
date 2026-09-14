import { Route, Routes } from "react-router-dom";
import { Landing } from "./pages/Landing";
import { Onboarding } from "./pages/Onboarding";
import { AppShell } from "./app/AppShell";
import { Dashboard } from "./pages/app/Dashboard";
import { PaymentsList } from "./pages/app/PaymentsList";
import { NewPayment } from "./pages/app/NewPayment";
import { QuoteView } from "./pages/app/QuoteView";
import { ActivityList } from "./pages/app/ActivityList";
import { Explain } from "./pages/app/Explain";
import { CheckoutDemo } from "./pages/app/CheckoutDemo";
import { Settings } from "./pages/app/Settings";
import { ContinuitySetup } from "./pages/app/ContinuitySetup";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="payments" element={<PaymentsList />} />
        <Route path="payments/new" element={<NewPayment />} />
        <Route path="obligations/:obligationId/quotes/:cycleId" element={<QuoteView />} />
        <Route path="activity" element={<ActivityList />} />
        <Route path="activity/:kind/:id" element={<Explain />} />
        <Route path="checkout" element={<CheckoutDemo />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/continuity" element={<ContinuitySetup />} />
      </Route>
    </Routes>
  );
}

export default App;
