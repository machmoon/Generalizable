import {
	IconArrowLeft,
	IconCloudDownload,
	IconCopy,
	IconFileTypePdf,
	IconMessage,
	IconNote,
	IconPlayerStop,
	IconUsersGroup,
	IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type { CinePane } from "../helpers/CornerstoneNifti2";
import { appRootRelativeUrl } from "./protocol";
import type { LiveRoomController } from "./types";
import LiveQuizDock from "./LiveQuizDock";

function formatCountdown(expiresAt: string, now: number): string {
	const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	const seconds = Math.floor((remaining % 60_000) / 1_000);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function LiveRoomHeader({ room, dockOpen, onToggleDock }: {
	room: LiveRoomController;
	dockOpen: boolean;
	onToggleDock: () => void;
}) {
	const [now, setNow] = useState(Date.now());
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const statusLabel = {
		connecting: "Connecting",
		connected: "Live",
		reconnecting: "Reconnecting",
		disconnected: "Offline",
		expired: "Expired",
		error: "Error",
	}[room.connectionState];
	return (
		<header className="lr-header">
			<div className="lr-header__identity">
				<span className="lr-live-dot" data-state={room.connectionState} />
				<div><strong>{room.metadata.mode === "quiz" ? "Live Quiz" : "Live Room"}</strong><span>Case {room.metadata.case_id} · {room.metadata.resolution}</span></div>
			</div>
			<div className="lr-header__warning">{room.metadata.mode === "quiz" ? "Private answers · reveal together" : "Anyone with link can edit"}</div>
			<div className="lr-header__actions">
				<span className="lr-status" data-state={room.connectionState}>{statusLabel}</span>
				<span className="lr-countdown" title="Room deletes automatically at expiration">{formatCountdown(room.metadata.expires_at, now)}</span>
				<a
					className="lr-header-button"
					href={appRootRelativeUrl(`/case/${room.metadata.case_id}`)}
					title="Leave the room and open this case in the normal viewer"
				>
					<IconArrowLeft size={18} /> Leave
				</a>
				<button className="lr-header-button" onClick={onToggleDock} aria-expanded={dockOpen}>
					<IconUsersGroup size={18} /> {room.participants.length}/8
				</button>
				<button className="lr-header-button lr-header-button--primary" onClick={() => {
					void room.copyShareLink().then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1800);
					});
				}}>
					<IconCopy size={18} /> {copied ? "Copied" : "Share"}
				</button>
			</div>
		</header>
	);
}

export function LiveRoomDock(props: {
	room: LiveRoomController;
	crosshair: [number, number, number] | null;
	activePlane: CinePane;
	onClose: () => void;
}) {
	if (props.room.metadata.mode === "quiz") {
		return <LiveQuizDock room={props.room} onClose={props.onClose} />;
	}
	return <ReviewLiveRoomDock {...props} />;
}

function ReviewLiveRoomDock({ room, crosshair, activePlane, onClose }: {
	room: LiveRoomController;
	crosshair: [number, number, number] | null;
	activePlane: CinePane;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<"people" | "notes" | "chat">("people");
	const [chat, setChat] = useState("");
	const [note, setNote] = useState("");
	const [exportError, setExportError] = useState<string | null>(null);
	const notes = useMemo(() => Object.values(room.state.notes).sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0)), [room.state.notes]);
	const editingDisabled = room.connectionState !== "connected";
	return (
		<aside className="lr-dock" aria-label="Live Room collaboration">
			<div className="lr-dock__head">
				<div><span className="lr-eyebrow">Collaborate</span><strong>{room.participants.length} connected</strong></div>
				<button className="lr-dock__close" onClick={onClose} aria-label="Close collaboration panel"><IconX size={18} /></button>
			</div>
			<div className="lr-tabs" role="tablist">
				<button role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}><IconUsersGroup size={16} /> People</button>
				<button role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}><IconNote size={16} /> Notes</button>
				<button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}><IconMessage size={16} /> Chat</button>
			</div>
			{(room.error || room.undoNotice || editingDisabled) && (
				<div className={`lr-banner ${editingDisabled ? "lr-banner--warning" : ""}`} role="status">
					{room.undoNotice || room.error || "Navigation still works, but collaborative edits are not being saved."}
				</div>
			)}
			<div className="lr-dock__body">
				{tab === "people" && (
					<div className="lr-people">
						{room.participants.map((participant) => {
							const self = participant.participant_id === room.participantId;
							const following = room.followingId === participant.participant_id;
							return (
								<div className="lr-person" key={participant.participant_id}>
									<span className="lr-avatar" style={{ background: participant.color }}>{participant.name.slice(0, 1).toUpperCase()}</span>
									<div><strong>{participant.name}{self ? " (you)" : ""}</strong><span>{participant.plane || "Reviewing scan"}{participant.active_tool ? ` · ${participant.active_tool}` : ""}</span></div>
									{!self && (
										<button className={following ? "is-following" : ""} onClick={() => following ? room.stopFollowing() : room.follow(participant.participant_id)}>
											{following ? <><IconPlayerStop size={15} /> Stop</> : "Follow"}
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}
				{tab === "notes" && (
					<div className="lr-thread">
						<form className="lr-compose" onSubmit={async (event) => {
							event.preventDefault();
							if (crosshair && note.trim() && await room.addNote(note.trim(), crosshair, activePlane)) setNote("");
						}}>
							<label htmlFor="lr-note">Pin note at current crosshair</label>
							<textarea id="lr-note" maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={crosshair ? "Finding or review note…" : "Place crosshair to anchor a note"} disabled={!crosshair || editingDisabled} />
							<button disabled={!crosshair || !note.trim() || editingDisabled}>Pin note</button>
						</form>
						{notes.length === 0 ? <div className="lr-empty">No pinned notes yet.</div> : notes.map((item) => (
							<article className="lr-message" key={item.id}>
								<div><strong>{item.author}</strong><time>{item.plane}</time></div>
								<p>{item.text}</p>
								<small>{item.world.map((value) => Math.round(value)).join(", ")} mm</small>
								{item.author === room.name && <button onClick={() => void room.deleteNote(item.id)} disabled={editingDisabled}>Delete</button>}
							</article>
						))}
					</div>
				)}
				{tab === "chat" && (
					<div className="lr-thread lr-thread--chat">
						<div className="lr-chat-list" aria-live="polite">
							{room.state.chat.length === 0 ? <div className="lr-empty">No messages yet.</div> : room.state.chat.map((message) => (
								<article className="lr-message" key={message.id}>
									<div><strong>{message.author}</strong>{message.timestamp && <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
									<p>{message.text}</p>
								</article>
							))}
						</div>
						<form className="lr-chat-compose" onSubmit={async (event) => {
							event.preventDefault();
							if (chat.trim() && await room.sendChat(chat.trim())) setChat("");
						}}>
							<label htmlFor="lr-chat">Room message</label>
							<textarea id="lr-chat" maxLength={2000} value={chat} onChange={(event) => setChat(event.target.value)} disabled={editingDisabled} placeholder="Message everyone…" />
							<button disabled={!chat.trim() || editingDisabled}>Send</button>
						</form>
					</div>
				)}
			</div>
			<div className="lr-export">
				<button onClick={() => void room.downloadExport("zip").catch((caught) => setExportError(caught.message))}><IconCloudDownload size={16} /> Export room ZIP</button>
				<button onClick={() => void room.downloadExport("pdf").catch((caught) => setExportError(caught.message))}><IconFileTypePdf size={16} /> PDF</button>
				{exportError && <div className="lr-error" role="alert">{exportError}</div>}
				<small>For research use only. Room deletes after 24 hours.</small>
			</div>
		</aside>
	);
}
