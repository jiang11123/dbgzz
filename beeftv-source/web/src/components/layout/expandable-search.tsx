import { useState } from "react";
import { Input } from "antd";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

type ExpandableSearchProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    className?: string;
};

export function ExpandableSearch({ value, onChange, placeholder, className }: ExpandableSearchProps) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div
            className={cn("workspace-expandable-search", className)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
            }}
        >
            {expanded ? (
                <Input
                    autoFocus
                    allowClear
                    className="workspace-expandable-search-input"
                    prefix={<Search className="size-4" />}
                    value={value}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    onChange={(event) => onChange(event.target.value)}
                />
            ) : (
                <button
                    type="button"
                    className={cn("workspace-expandable-search-button", value && "is-active")}
                    aria-label={value ? `${placeholder}，当前关键词：${value}` : placeholder}
                    title={placeholder}
                    onClick={() => setExpanded(true)}
                >
                    <Search className="size-4" />
                </button>
            )}
        </div>
    );
}
