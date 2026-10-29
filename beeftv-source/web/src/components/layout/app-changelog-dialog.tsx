import { motion, useReducedMotion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { appChangelogZh } from "@/components/layout/app-changelog.zh";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { useThemeStore } from "@/stores/use-theme-store";

export function AppChangelogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const reducedMotion = useReducedMotion();
    const [showLicenses, setShowLicenses] = useState(false);
    const theme = useThemeStore((state) => state.theme);
    const version = `v${__APP_VERSION__.replace(/^v/, "")}`;
    const publishedNotes = appChangelogZh.filter((entry) => entry.version.localeCompare(version, undefined, { numeric: true }) <= 0);
    const notes = publishedNotes[0]?.version === version
        ? publishedNotes
        : [{ version, changes: ["当前版本的更新内容将在发布后提供。"] }, ...publishedNotes];

    return (
        <AppModal
            rootClassName="app-spatial-modal app-changelog-modal"
            title={<div className="app-changelog-heading"><span>{showLicenses ? "第三方许可与源码" : "更新日志"}</span><span className="app-changelog-heading-version">{version}</span></div>}
            open={open}
            width={680}
            footer={<button type="button" className="text-sm text-primary underline-offset-4 hover:underline focus-visible:underline" onClick={() => setShowLicenses(!showLicenses)}>{showLicenses ? "返回更新日志" : "第三方许可与源码"}</button>}
            centered
            onCancel={() => { setShowLicenses(false); onClose(); }}
            modalRender={(node) => (
                <motion.div initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.975 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: aceternityMotion.duration.panel, ease: aceternityMotion.easing.enter }}>
                    {node}
                </motion.div>
            )}
        >
            {showLicenses ? <iframe title="第三方许可与源码" src="/licenses/index.html" className="block h-[min(60vh,560px)] w-full border-0" style={{ colorScheme: theme }} /> : <div className="app-changelog-scroll thin-scrollbar">
                {notes.map((entry, index) => (
                    <details className="app-changelog-release" key={entry.version} open={index === 0 ? true : undefined}>
                        <summary className="app-changelog-release-summary">
                            <span>{index === 0 ? "本次更新" : entry.version}</span>
                            <ChevronDown className="app-changelog-chevron" aria-hidden="true" />
                        </summary>
                        <ul className="app-changelog-list">
                            {entry.changes.map((change) => <li key={change}>{change}</li>)}
                        </ul>
                    </details>
                ))}
            </div>}
        </AppModal>
    );
}
