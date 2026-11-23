import AssistantChat from "./AssistantChat";
import Icon from "@/components/Icon";

// Ask: a fixed column on the right of the window, opened from the sidebar.
// It stays mounted while closed so an answer on its way still arrives.
export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <aside className={`fixed inset-y-0 right-0 z-40 w-[380px] max-w-full flex-col border-l border-line bg-canvas ${open ? "flex" : "hidden"}`} aria-label="Ask">
      <header className="bar">
        <h2 className="bar-title">Ask</h2>
        <span className="flex-1" />
        <button className="iconbtn" onClick={onClose} aria-label="Close Ask" title="Close">
          <Icon name="close" size={16} />
        </button>
      </header>
      <AssistantChat className="min-h-0 flex-1" visible={open} />
    </aside>
  );
}
