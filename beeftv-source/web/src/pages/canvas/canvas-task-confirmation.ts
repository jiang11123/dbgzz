import type { ModalFuncProps } from "antd";
import "./canvas-task-confirmation.css";

/** Shared presentation for deleting a running node and cancelling its task. */
export const canvasTaskConfirmation: ModalFuncProps = {
    centered: true,
    width: 420,
    icon: null,
    className: "canvas-task-confirmation",
    okButtonProps: { autoInsertSpace: false },
    cancelButtonProps: { autoInsertSpace: false },
};
