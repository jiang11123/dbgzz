import { Button } from "antd";
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

/** 内容库的浏览控件，不复用后台表格的筛选外框。 */
export function CollectionToolbar({ children, trailing, active, onReset, label = "搜索与筛选" }: {
    children: ReactNode;
    trailing?: ReactNode;
    active?: boolean;
    onReset?: () => void;
    label?: string;
}) {
    return <section className="collection-toolbar" aria-label={label}>
        <div className="collection-toolbar-controls">{children}</div>
        <div className="collection-toolbar-actions">
            {active && onReset ? <Button type="text" icon={<RotateCcw />} onClick={onReset}>重置</Button> : null}
            {trailing}
        </div>
    </section>;
}
