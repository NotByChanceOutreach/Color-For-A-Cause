import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { PageDetail } from "./pages/PageDetail";
import { PrintPage } from "./pages/PrintPage";
import { Submit } from "./pages/Submit";
import { Success } from "./pages/Success";
import { Wall } from "./pages/Wall";
import { Artwork } from "./pages/Artwork";
import { Packs } from "./pages/Packs";
import { Host } from "./pages/Host";
import { GroupSubmit } from "./pages/GroupSubmit";
import {
  About,
  AccessibilityPage,
  ConsentPage,
  Contact,
  GrownUps,
  Impact,
  Privacy,
  Standards,
} from "./pages/InfoPages";
import {
  StaffGate,
  StaffHome,
  StaffImpact,
  StaffLogin,
  StaffLogs,
  StaffPages,
  StaffReview,
  StaffSubmissions,
} from "./pages/Admin";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/color" element={<Library />} />
        <Route path="/color/:slug" element={<PageDetail />} />
        <Route path="/submit" element={<Submit />} />
        <Route path="/submit/success/:id" element={<Success />} />
        <Route path="/submit/group" element={<GroupSubmit />} />
        <Route path="/wall" element={<Wall />} />
        <Route path="/wall/:id" element={<Artwork />} />
        <Route path="/packs" element={<Packs />} />
        <Route path="/host" element={<Host />} />
        <Route path="/grown-ups" element={<GrownUps />} />
        <Route path="/about" element={<About />} />
        <Route path="/impact" element={<Impact />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/consent" element={<ConsentPage />} />
        <Route path="/standards" element={<Standards />} />
        <Route path="/accessibility" element={<AccessibilityPage />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/print/:slug" element={<PrintPage />} />
      </Route>
      <Route path="/staff/login" element={<StaffLogin />} />
      <Route path="/staff" element={<StaffGate />}>
        <Route index element={<StaffHome />} />
        <Route path="submissions" element={<StaffSubmissions />} />
        <Route path="submissions/:id" element={<StaffReview />} />
        <Route path="pages" element={<StaffPages />} />
        <Route path="impact" element={<StaffImpact />} />
        <Route path="logs" element={<StaffLogs />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
