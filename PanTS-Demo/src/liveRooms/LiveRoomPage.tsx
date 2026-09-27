import { IconAlertTriangle, IconArrowLeft, IconUsersGroup } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import VisualizationPage from "../routes/VisualizationPage";
import { appRootRelativeUrl, bootstrapLiveRoom, getLiveRoomParticipantCredential, roomKeyFromFragment } from "./protocol";
import type { LiveQuizHostCredential, LiveQuizState, LiveRoomDurableState, LiveRoomMetadata } from "./types";
import { useLiveRoom } from "./useLiveRoom";
import "./liveRooms.css";

type Bootstrap = {
	metadata: LiveRoomMetadata;
	state: LiveRoomDurableState;
	maskUrl: string;
	snapshotSequence: number;
	quiz: LiveQuizState | null;
};

type LiveRoomNavigationState = {
	liveRoomCreation?: {
		creatorName?: string;
		quizHostCredential?: LiveQuizHostCredential;
	};
};

function JoinDialog({ initialName, onJoin }: { initialName: string; onJoin: (name: string) => void }) {
	const [name, setName] = useState(initialName);
	return (
		<div className="lr-page lr-page--center">
			<form className="lr-modal lr-join" onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) onJoin(name.trim());
			}}>
				<div className="lr-join__mark"><IconUsersGroup size={24} /></div>
				<span className="lr-eyebrow">BodyMaps Live Room</span>
				<h1>Join Live Room</h1>
				<p>Enter a display name to join synchronized scan review or a private-answer quiz.</p>
				<label className="lr-field">
					<span>Display name</span>
					<input autoFocus maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
				</label>
				<button className="lr-button lr-button--primary lr-button--wide" disabled={!name.trim()}>Join room</button>
				<small>Temporary name stays in this browser tab for reconnect only.</small>
			</form>
		</div>
	);
}

function LiveRoomErrorPage({ message, roomId }: { message: string; roomId: string }) {
	const caseId = sessionStorage.getItem(`bodymaps.live-room.${roomId}.case-id`);
	const expired = /expired|deleted/i.test(message);
	return (
		<main className="lr-page lr-page--center">
			<div className="lr-expired" role="alert">
				<IconAlertTriangle size={28} />
				<h1>{expired ? "Live Room expired" : "Room unavailable"}</h1>
				<p>{expired ? "Room data was deleted after its 24-hour lifetime." : message}</p>
				<a className="lr-button lr-button--primary" href={appRootRelativeUrl(caseId ? `/case/${caseId}` : "/dashboard")}>
					<IconArrowLeft size={18} /> {caseId ? `Return to case ${caseId}` : "Return to dashboard"}
				</a>
			</div>
		</main>
	);
}

function ConnectedRoom({ bootstrap, roomKey, name, quizHostCredential, onQuizHostCredentialAccepted }: {
	bootstrap: Bootstrap;
	roomKey: string;
	name: string;
	quizHostCredential?: LiveQuizHostCredential;
	onQuizHostCredentialAccepted: () => void;
}) {
	const controller = useLiveRoom({
		metadata: bootstrap.metadata,
		roomKey,
		name,
		maskUrl: bootstrap.maskUrl,
		snapshotSequence: bootstrap.snapshotSequence,
		initialState: bootstrap.state,
		initialQuiz: bootstrap.quiz,
		quizHostCredential,
		onQuizHostCredentialAccepted,
		onAuthoritativeResync: () => window.location.reload(),
	});
	return <VisualizationPage liveRoom={controller} />;
}

function BootstrappingRoom({ roomId, roomKey, name, quizHostCredential, onQuizHostCredentialAccepted }: {
	roomId: string;
	roomKey: string;
	name: string;
	quizHostCredential?: LiveQuizHostCredential;
	onQuizHostCredentialAccepted: () => void;
}) {
	const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		let ownedMaskUrl: string | null = null;
		setBootstrap(null);
		setError(null);
		bootstrapLiveRoom(roomId, roomKey).then((result) => {
			if (!active) {
				URL.revokeObjectURL(result.maskUrl);
				return;
			}
			ownedMaskUrl = result.maskUrl;
			sessionStorage.setItem(`bodymaps.live-room.${roomId}.case-id`, result.metadata.case_id);
			setBootstrap(result);
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught.message : "Room unavailable");
		});
		return () => {
			active = false;
			if (ownedMaskUrl) URL.revokeObjectURL(ownedMaskUrl);
		};
	}, [roomId, roomKey]);

	if (error) return <LiveRoomErrorPage message={error} roomId={roomId} />;
	if (!bootstrap) return (
		<div className="lr-page lr-page--center" role="status">
			<div className="lr-loading-ring" />
			<p>Loading shared scan…</p>
		</div>
	);
	return <ConnectedRoom key={`${roomId}:${roomKey}`} bootstrap={bootstrap} roomKey={roomKey} name={name} quizHostCredential={quizHostCredential} onQuizHostCredentialAccepted={onQuizHostCredentialAccepted} />;
}

export default function LiveRoomPage() {
	const { roomId = "" } = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const roomKey = roomKeyFromFragment();
	const storedName = sessionStorage.getItem("bodymaps.live-room.name") || "";
	const navigationState = location.state as LiveRoomNavigationState | null;
	const creation = navigationState?.liveRoomCreation;
	const [name, setName] = useState<string | null>(() => {
		if (creation?.creatorName) return creation.creatorName;
		return storedName && getLiveRoomParticipantCredential(roomId) ? storedName : null;
	});
	const [quizHostCredential, setQuizHostCredential] = useState(creation?.quizHostCredential);
	const clearQuizHostCredential = () => {
		setQuizHostCredential(undefined);
		navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
	};

	useEffect(() => {
		document.querySelector('meta[name="referrer"]')?.setAttribute("content", "no-referrer");
	}, []);

	if (!roomKey) return <LiveRoomErrorPage message="Room link is missing its secret key." roomId={roomId} />;
	if (!name) return <JoinDialog initialName={storedName} onJoin={(value) => {
		sessionStorage.setItem("bodymaps.live-room.name", value);
		setName(value);
	}} />;
	return <BootstrappingRoom key={`${roomId}:${roomKey}`} roomId={roomId} roomKey={roomKey} name={name} quizHostCredential={quizHostCredential} onQuizHostCredentialAccepted={clearQuizHostCredential} />;
}
