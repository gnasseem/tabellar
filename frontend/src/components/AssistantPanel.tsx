
import AssistantChat from "./AssistantChat";
import Icon from "@/components/Icon";

export default function AssistantPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* Slide-out panel */}
      <div
        className={`fixed top-[52px] right-0 h-[calc(100%-52px)] w-[380px] bg-canvas border-l border-line shadow-2xl z-50 flex flex-col transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line shrink-0">
          <Icon name="assistant" size={20} className="text-wax" />
          <span className="font-medium text-sm text-ink flex-1">
            Assistant
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-field text-ink3 transition-colors"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <AssistantChat className="flex-1 min-h-0" visible={open} />
      </div>
    </>
  );
}
