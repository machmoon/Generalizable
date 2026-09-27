import { forwardRef, useState } from "react";
import { setPaneSliceIndex, type CinePane, type SliceInfo } from "../helpers/CornerstoneNifti2";

type Props = {
    pane: CinePane;
    info: SliceInfo;
}

const SliceJumpInput = forwardRef<HTMLDivElement, Props>(function SliceJumpInput({ pane, info }, ref) {
    const [isEditing, setIsEditing] = useState(false);
    const [inputValue, setInputValue] = useState(String(info.current + 1));

    const startEditing = () => {
        setInputValue(String(info.current + 1));
        setIsEditing(true);
    };

    const commitEdit = () => {
        const typedNumber = Number(inputValue);
        if (!Number.isNaN(typedNumber) && typedNumber >= 1 && typedNumber <= info.total) {
            setPaneSliceIndex(pane, typedNumber - 1);
        }
        setIsEditing(false);
    };

    return (
        <div
            ref={ref}
            style={{ position: "absolute", right: 10, bottom: 10, zIndex: 50, width: 56, textAlign: "right" }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            {isEditing ? (
                <input
                    type="number"
                    className="vp-slice-jump-input"
                    style={{ position: "static", width: "100%", boxSizing: "border-box", pointerEvents: "auto" }}
                    value={inputValue}
                    autoFocus
                    min={1}
                    max={info.total}
                    onChange={(e) => setInputValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setIsEditing(false);
                    }}
                />
            ) : (
                <div
                    className="vp-slice-caption"
                    style={{ position: "static", cursor: "pointer", pointerEvents: "auto" }}
                    title="Click to jump to a slice, or scroll"
                    onClick={startEditing}
                    onWheel={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const direction = e.deltaY > 0 ? -1 : 1;
                        setPaneSliceIndex(pane, info.current + direction);
                    }}
                >
                    {info.current + 1}/{info.total}
                </div>
            )}
        </div>
    );
});

export default SliceJumpInput;
