"""Answer shaping for the BodyMaps AI assistant.

Everything in here is about *what the assistant says*, kept out of the request
plumbing in api_blueprint.py so it can be read and tuned on its own:

  * the system prompts (text turns and, first-class, vision turns),
  * the relevance gate that stops measured case facts from being pasted onto a
    question that never asked for them,
  * the guarantee that a reply which still needs information ends by asking for
    it — phrased around what can be *seen* when screenshots are in play,
  * the honest failure text used when no model could answer.

The module is deliberately dependency-free (stdlib only) so it is importable
from a test, a script, or the blueprint without dragging in Flask.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Sequence


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------

def normalize(value: Any) -> str:
    """Lowercase, punctuation-flattened text used for all keyword matching."""
    text = str(value or "").lower()
    text = text.replace(".nii.gz", " ").replace(".nii", " ")
    text = re.sub(r"[_/]+", " ", text)
    return " ".join(text.split())


def _strip_markdown(value: str) -> str:
    return re.sub(r"[*_`#]+", "", str(value or ""))


# Organs the viewer segments, plus the words a clinician actually uses for them.
# Used both to detect what a question is about and to pick a follow-up that is
# specific instead of generic.
_ORGAN_SYNONYMS: dict[str, tuple[str, ...]] = {
    "pancreas": ("pancreas", "pancreatic", "uncinate", "ampulla", "whipple"),
    "liver": ("liver", "hepatic", "hepato", "cirrhosis", "steatosis"),
    "gallbladder": ("gallbladder", "gall bladder", "cholecyst", "biliary", "bile duct", "cbd"),
    "spleen": ("spleen", "splenic"),
    "stomach": ("stomach", "gastric"),
    "kidney": ("kidney", "kidneys", "renal", "nephro"),
    "adrenal gland": ("adrenal",),
    "aorta": ("aorta", "aortic"),
    "inferior vena cava": ("vena cava", "ivc"),
    "portal vein": ("portal vein", "portal", "splenic vein", "smv", "mesenteric"),
    "duodenum": ("duodenum", "duodenal"),
    "colon": ("colon", "colonic", "bowel"),
    "small bowel": ("small bowel", "jejunum", "ileum"),
    "esophagus": ("esophagus", "oesophagus", "esophageal"),
    "bladder": ("bladder", "vesical"),
    "prostate": ("prostate", "prostatic"),
    "lung": ("lung", "lungs", "pulmonary", "pleural"),
    "vertebrae": ("vertebra", "vertebrae", "spine", "spinal", "vertebral"),
    "rib": ("rib", "ribs"),
    "femur": ("femur", "femoral"),
}

_DEMOGRAPHIC_WORDS = (
    "age", "aged", "old", "sex", "male", "female", "man", "woman",
    "bmi", "body mass", "height", "weight", "demographic",
)

_MEASUREMENT_WORDS = (
    "volume", "cm3", "cm³", "size", "how big", "how large", "measure",
    "measured", "measurement", "mean hu", "hounsfield", "attenuation",
    "density", "percentile", "largest", "smallest",
)


def organs_mentioned(message: str) -> list[str]:
    """Canonical organ names referenced anywhere in a message."""
    norm = normalize(message)
    found: list[str] = []
    for organ, words in _ORGAN_SYNONYMS.items():
        if any(word in norm for word in words):
            found.append(organ)
    return found


def asks_for_measurement(message: str) -> bool:
    norm = normalize(message)
    return any(word in norm for word in _MEASUREMENT_WORDS)


def asks_about_demographics(message: str) -> bool:
    norm = normalize(message)
    return any(re.search(rf"\b{re.escape(word)}\b", norm) for word in _DEMOGRAPHIC_WORDS)


# ---------------------------------------------------------------------------
# Relevance gate for measured case facts
# ---------------------------------------------------------------------------

def _fact_subject(fact: str) -> str:
    """The thing a generated fact sentence is about ('Liver', 'Age', ...)."""
    plain = _strip_markdown(fact).strip()

    labelled = re.match(r"^([A-Za-z][A-Za-z \-]{0,30}):", plain)
    if labelled:
        return labelled.group(1).strip()

    inline = re.search(
        r"\bsegmented\s+([A-Za-z][A-Za-z \-]{0,30}?)\s+(?:volume|mean)\b",
        plain,
        flags=re.IGNORECASE,
    )
    if inline:
        return inline.group(1).strip()

    return plain[:40]


def fact_is_relevant(fact: str, message: str, *, conversation_text: str = "") -> bool:
    """Whether a measured fact belongs in the answer to THIS question.

    The assistant used to append every fact it had computed for the open case.
    Asked about a patient's bilirubin and MRCP, it would answer with the open
    scan's liver volume and the patient's age — numbers that are individually
    correct and collectively an answer to a question nobody asked. A fact now
    has to earn its place by being about something the user actually raised.
    """
    subject = _fact_subject(fact)
    subject_norm = normalize(subject)
    haystack = normalize(f"{message} {conversation_text}")

    if not subject_norm:
        return False

    if subject_norm in {"age", "sex", "bmi", "height", "weight"}:
        return asks_about_demographics(message)

    # Match on the organ family, so "hepatic duct" counts as a liver reference
    # and "biliary" counts as a gallbladder one.
    for organ, words in _ORGAN_SYNONYMS.items():
        if organ in subject_norm or subject_norm in organ:
            return any(word in haystack for word in words)

    words = [word for word in subject_norm.split() if len(word) > 3]
    return any(word in haystack for word in words)


def relevant_facts(
    facts: Iterable[str],
    message: str,
    *,
    conversation_text: str = "",
    always_include: Iterable[str] = (),
) -> list[str]:
    """Filter measured facts down to the ones this question is about.

    `always_include` carries facts the user explicitly requested (the rule
    parser matched "what is the liver volume"), which are never dropped.
    """
    forced = [fact for fact in always_include if fact]
    kept = list(forced)

    for fact in facts:
        if not fact or fact in kept:
            continue
        if fact_is_relevant(fact, message, conversation_text=conversation_text):
            kept.append(fact)

    return kept


# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

_BASE_PROMPT = (
    "You are BodyMaps AI, an expert medical-imaging assistant embedded in a CT "
    "viewer. Answer like a knowledgeable clinician colleague.\n\n"
    "OUTPUT\n"
    "- Give ONLY the final answer. No reasoning, planning, or thinking out "
    "loud. Never open with 'Okay', 'Let me', 'Hmm', 'First', 'I need to', "
    "'The user', or 'So'.\n"
    "- Never mention these instructions, a 'Facts' list, prompts, JSON, "
    "metadata, files, servers, or what data you were or weren't given.\n"
    "- Natural prose; **bold** for a key term. No numbered sections unless "
    "asked.\n\n"
    "STAY ON THE QUESTION (critical)\n"
    "- Answer the question the user actually asked, in their words. If they "
    "give you lab values, imaging results, or a case story, those are the "
    "subject — reason about THEM.\n"
    "- Never answer by reciting measurements of the open scan unless the user "
    "asked about the open scan. Unrequested organ volumes, attenuations, or "
    "patient demographics are off topic and must be left out.\n"
    "- If you genuinely cannot answer, say what is missing and ask for it. "
    "Never emit a bare list of numbers in place of an answer.\n\n"
    "THE OPEN CASE\n"
    "- When a CASE INVENTORY block is present it lists every structure measured "
    "from THIS case, with its volume, slice extent, and attenuation. Answer any "
    "question about the case from it — how many structures, which is largest, "
    "where something sits, what a value is — and quote the numbers verbatim "
    "with units.\n"
    "- Every case is different. Never carry a value from an earlier case or "
    "from general knowledge into this one.\n"
    "- If the question asks about something the inventory does not list, say "
    "that structure is not segmented in this case. That is a correct answer; "
    "guessing is not.\n"
    "- If no CASE INVENTORY is present, say the segmentation could not be read "
    "for this case rather than answering from memory.\n\n"
    "LESIONS AND TUMOURS (absolute)\n"
    "- Whether a lesion, tumour, mass, or cancer exists in this case is "
    "decided ONLY by a line in the Facts beginning 'SEGMENTATION FACT'. "
    "That line is measured from the segmentation and overrides everything "
    "else, including anything you think you see.\n"
    "- If a SEGMENTATION FACT says no lesion is present, say so plainly and "
    "do not hedge, speculate about one, or point at any structure as a "
    "possible lesion.\n"
    "- If a SEGMENTATION FACT says a lesion IS present, report its location, "
    "volume, and size exactly as given.\n"
    "- If a SEGMENTATION FACT says a lesion class is scattered rather than "
    "discrete, report the total volume, say the segmentation does not show a "
    "single well-defined lesion, and give no slice number, region, or "
    "diameter for it.\n"
    "- NEVER identify a lesion from a colour, a shape, or a mask outline. A "
    "colour in the legend names an organ, never a tumour.\n"
    "- If no SEGMENTATION FACT about lesions is present, say the "
    "segmentation could not be checked and ask the user to confirm the case "
    "is loaded. Do not guess either way.\n\n"
    "LENGTH\n"
    "- Simple question: 1-3 sentences. Clinical question or case vignette: one "
    "focused paragraph (~4-8 sentences).\n"
    "- Multi-part or structured request ('first... second...', 'teach a "
    "resident'): cover EVERY part in the user's order, a short paragraph each, "
    "none skipped.\n"
    "- Always finish every sentence.\n\n"
    "QUESTION TYPES\n"
    "- GENERAL MEDICAL, including vignettes the user types ('A 57-year-old man "
    "presents with...'): answer fully from your medical knowledge — most likely "
    "answer, brief reasoning, closest alternative. Never refuse, never ask for "
    "scan data for these.\n"
    "- ABOUT THIS SCAN ('this case', a measured organ): quote the 'Facts:' "
    "values verbatim with units and tie every case claim to one. Never invent "
    "or recompute a value.\n"
    "- CLINICAL ('is this normal', 'could this be...', symptoms, management): "
    "say what the findings suggest, the leading possibilities and what "
    "distinguishes them, sensible next steps, and flag anything urgent. "
    "Educational and non-diagnostic ('suggests', 'consistent with') — but never "
    "refuse to engage.\n\n"
    "CONTINUITY (critical): if your last reply asked a question, the user's "
    "next message answers it — fold it in, refine the assessment, say what it "
    "changes, then ask the next useful question. Never restart, never call "
    "missing what was just given, and never treat a patient described in chat "
    "as the open scan.\n\n"
    "ENDING\n"
    "- Give the answer and STOP. If you have answered the question, do not add "
    "a closing question, an offer, or a suggestion of what to do next.\n"
    "- ONLY when you genuinely lack information needed to answer: say briefly "
    "what is missing, then ask ONE specific question for exactly that.\n"
    "- The closing question must FOLLOW FROM the answer you just gave. Never "
    "ask about window presets, colours, or other display settings unless the "
    "user raised them.\n"
    "- Never reply with only a question. If you have nothing to answer with, "
    "say what is missing first, then ask for it.\n"
    "- One question, never a list. A pure viewer command needs only a brief "
    "confirmation."
)

# HIDDEN VISION PROMPT.
#
# This is the instruction set that makes attached screenshots usable. It is the
# most important prompt in the product — BodyMaps is a vision-first application,
# and the model has to be told exactly what the artifacts in a captured CT pane
# mean, or it reads crosshairs as hardware and mask colors as pathology.
_VISION_PROMPT = (
    "\n\n=== ATTACHED CT VIEWER SCREENSHOTS — THIS IS THE PRIMARY EVIDENCE ===\n"
    "Images from the CT viewer are attached. They are the subject of this turn: "
    "look at them and describe what is actually there. Ground every visual "
    "claim in something visible in a specific pane, and name the pane you saw "
    "it in.\n\n"
    "WHAT THE PANES ARE\n"
    "- Up to four panes may be attached, in this order: axial (cross-section, "
    "viewed from the feet — the patient's LEFT is on the RIGHT of the image), "
    "sagittal (side view, anterior to one side), coronal (front view), and a 3D "
    "surface rendering of the segmented organs.\n"
    "- Name each pane you are describing so the reader can follow along.\n\n"
    "OVERLAYS ARE NOT ANATOMY\n"
    "- Semi-transparent colored regions are SEGMENTATION MASKS, one color per "
    "organ. Identify organs using the supplied color list and never contradict "
    "it; if a color is not in the list, say the region is unlabeled rather than "
    "guessing an organ.\n"
    "- Thin straight crosshair lines are slice-position guides. They are "
    "navigation, never a wire, catheter, fracture, or vessel.\n"
    "- Corner letters are orientation (A/P/L/R/S/I). Corner numbers are window "
    "width/level and zoom, not measurements of the patient.\n\n"
    "HOW TO READ\n"
    "- Work through the user's request in the order they asked for it, covering "
    "every part.\n"
    "- Describe position relationally (anterior/posterior, medial/lateral, "
    "cranial/caudal) and relative to neighboring structures.\n"
    "- Compare paired structures (the two kidneys) for size, level, and "
    "symmetry when relevant.\n\n"
    "LESIONS IN THE IMAGES\n"
    "- A screenshot cannot establish that a lesion exists. Only a "
    "'SEGMENTATION FACT' line in the Facts can. Never call a coloured "
    "region a tumour, lesion, or mass because of how it looks.\n"
    "- When a SEGMENTATION FACT places a lesion, you may point to where it "
    "would appear in these panes — but the finding itself comes from the "
    "fact, not from the pixels.\n\n"
    "HONESTY ABOUT WHAT A SCREENSHOT CANNOT SHOW (required)\n"
    "- A single captured slice cannot establish contrast phase, lesion "
    "conspicuity below screen resolution, true HU values, or anything outside "
    "the captured field of view. When the user asks what cannot be judged, say "
    "so plainly and specifically.\n"
    "- Never invent a finding to fill a gap. 'Not assessable from this capture' "
    "is a correct and useful answer.\n"
    "- If a pane is blank, black, or unreadable, say which pane and ask the "
    "user to re-capture it. Do not describe an image you cannot see.\n\n"
    "ENDING A VISION ANSWER\n"
    "- Answer what was asked and stop. Do not routinely ask for another view.\n"
    "- ONLY when the question cannot be answered from what is attached: say "
    "which pane or view you would need — a named slice level, a different "
    "plane, a window preset, a zoom on a named structure, or a re-capture — "
    "and ask for that one thing.\n"
    "Stay educational and non-diagnostic."
)


def build_system_prompt(
    *,
    has_images: bool,
    has_case: bool = False,
) -> str:
    """System prompt for one streamed turn."""
    prompt = _BASE_PROMPT
    if has_case:
        prompt += (
            "\n\nA CT case is open in the viewer. Only bring it up if the user's "
            "question is about it."
        )
    if has_images:
        prompt += _VISION_PROMPT
    return prompt


def build_legend_fact(mask_legend: Sequence[dict[str, Any]]) -> str | None:
    """One line mapping every visible mask color to its organ."""
    pairs = [
        f"{str(entry.get('organ') or '').replace('_', ' ')}: {entry.get('color')}"
        for entry in mask_legend or []
        if entry.get("organ") and entry.get("color")
    ]
    if not pairs:
        return None
    return (
        "Segmentation mask colors in the attached screenshots — "
        + ", ".join(pairs)
        + "."
    )


# ---------------------------------------------------------------------------
# Follow-up question guarantee
# ---------------------------------------------------------------------------

# Phrases that mean the model knows it is short of information. When one of
# these shows up without a question mark, the reply has stated a need and then
# failed to ask — exactly the behavior we are correcting.
_UNCERTAINTY_MARKERS = (
    "cannot be determined", "can't be determined", "not assessable",
    "cannot be assessed", "can't be assessed", "would need", "i would need",
    "not enough information", "insufficient information", "unclear from",
    "not possible to tell", "cannot tell", "can't tell", "more information",
    "additional information", "not visible", "not shown", "unable to",
    "cannot confirm", "can't confirm", "further evaluation", "further imaging",
)


def _ends_with_question(reply: str) -> bool:
    """Whether the reply closes by asking something.

    Only the tail counts: a rhetorical question in the middle of a teaching
    paragraph is not the assistant asking the user for anything.
    """
    text = _strip_markdown(reply).strip()
    if not text:
        return False
    tail = text[-320:]
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", tail) if s.strip()]
    if not sentences:
        return False
    return sentences[-1].endswith("?")


def signals_missing_information(reply: str) -> bool:
    lowered = _strip_markdown(reply).lower()
    return any(marker in lowered for marker in _UNCERTAINTY_MARKERS)


_WINDOW_FOR_ORGAN = {
    "liver": "liver",
    "pancreas": "soft tissue",
    "gallbladder": "soft tissue",
    "spleen": "soft tissue",
    "kidney": "soft tissue",
    "lung": "lung",
    "vertebrae": "bone",
    "rib": "bone",
    "femur": "bone",
    "aorta": "soft tissue",
}

_GENERIC_VISION_QUESTIONS = (
    "Which view should I look at next — a different slice level, another plane, "
    "or the 3D surface rendering?",
    "Would it help if you re-captured the panes at a different slice level, or "
    "in a different window preset?",
    "Is there a particular structure in these views you want me to zoom in on?",
)

_GENERIC_CASE_QUESTIONS = (
    "Would you like me to isolate any of these structures in the viewer so we "
    "can look at them directly?",
    "Do you want me to pull up the measurements for a specific structure in "
    "this case?",
)

_GENERIC_CLINICAL_QUESTIONS = (
    "What other findings, labs, or history do you have for this patient?",
    "Is there anything else from the workup you can share so I can narrow this "
    "down?",
)


def _pick(options: Sequence[str], seed_text: str) -> str:
    """Stable, varied choice — the same question never repeats twice in a row
    for different messages, but one message always gets the same follow-up."""
    if not options:
        return ""
    return options[sum(ord(ch) for ch in seed_text[:64]) % len(options)]


def suggest_followup(
    message: str,
    *,
    has_images: bool,
    has_case: bool,
) -> str:
    """One short, specific question to close a reply with.

    Vision-focused whenever screenshots are in play: BodyMaps is a viewer, so
    the most useful next step is nearly always something to LOOK at.
    """
    organs = organs_mentioned(message)

    if has_images:
        if organs:
            organ = organs[0]
            window = _WINDOW_FOR_ORGAN.get(organ, "soft tissue")
            return (
                f"Which {organ} slice would you like me to look at next — a "
                f"different level, or the same one in the {window} window?"
            )
        return _pick(_GENERIC_VISION_QUESTIONS, message)

    if has_case and organs:
        organ = organs[0]
        return (
            f"Would you like me to isolate the {organ} in the viewer and capture "
            "the views so I can look at it directly?"
        )

    if has_case:
        return _pick(_GENERIC_CASE_QUESTIONS, message)

    return _pick(_GENERIC_CLINICAL_QUESTIONS, message)


def ensure_followup(
    reply: str,
    message: str,
    *,
    has_images: bool,
    has_case: bool = False,
    force: bool = False,
) -> str:
    """Guarantee the reply ends by asking for what it still needs.

    The model is instructed to do this, but small local models drop the closing
    question exactly when it matters most — after admitting something could not
    be determined. `force` appends one unconditionally (used for vision turns,
    where there is always a next thing worth looking at).
    """
    text = str(reply or "").rstrip()
    if not text:
        return text

    if _ends_with_question(text):
        return text

    if not force and not signals_missing_information(text):
        return text

    question = suggest_followup(message, has_images=has_images, has_case=has_case)
    if not question:
        return text

    separator = "\n\n" if "\n" in text else " "
    return f"{text}{separator}{question}"


# ---------------------------------------------------------------------------
# Honest failure text
# ---------------------------------------------------------------------------

def model_offline_reply(
    *,
    has_images: bool,
    vision_model_missing: bool = False,
    configured_vision_model: str = "",
) -> str:
    """What to say when no model produced an answer.

    Never a dump of whatever numbers happened to be computed for the open case:
    that reads as a confident non-sequitur. Say what failed and what fixes it.
    """
    if vision_model_missing:
        model = configured_vision_model or "qwen3-vl:4b"
        return (
            "I can't read the attached views right now — no vision model is "
            f"available on this server. Pulling one (`ollama pull {model}`) and "
            "restarting the backend will enable image reading. In the meantime "
            "I can still answer from text, and the viewer controls in the top "
            "panel all work.\n\n"
            "Would you like me to answer the anatomy question from the case "
            "measurements instead, while the model is set up?"
        )

    if has_images:
        return (
            "I couldn't finish reading the attached views — the local model "
            "didn't return an answer. Please send them again in a moment.\n\n"
            "If it keeps failing, would you re-capture the panes? A blank or "
            "partially rendered pane can stall the read."
        )

    return (
        "I couldn't get an answer just now — the local model didn't respond. "
        "Please try again in a moment; the viewer controls in the top panel "
        "still work.\n\n"
        "Would you like me to retry the same question?"
    )


# ---------------------------------------------------------------------------
# Lesion questions
#
# These are the questions that must never be answered from the model's own
# impression: "where is the pancreatic lesion", "does this case have a tumour".
# Detection here decides whether the request is grounded in the labelmap at all,
# so it is deliberately broad — a false positive costs one cheap lookup, a false
# negative costs a fabricated finding.
# ---------------------------------------------------------------------------

_LESION_WORDS = (
    "lesion", "tumor", "tumour", "mass", "cancer", "carcinoma", "neoplasm",
    "malignan", "metasta", "nodule", "growth", "oncolog", "pdac", "cyst",
)

# Organs that have a lesion class in the segmentation.
_LESION_ORGANS = ("pancreas", "liver", "kidney", "colon")


def asks_about_lesion(message: str) -> bool:
    """Whether the question is about a lesion, tumour, or mass."""
    norm = normalize(message)
    return any(word in norm for word in _LESION_WORDS)


def lesion_focus_organs(message: str) -> list[str]:
    """Which lesion-bearing organs the question is about.

    An empty list means "no organ named" — the caller should then report every
    lesion class, because "is there a tumour?" is a question about all of them.
    """
    mentioned = organs_mentioned(message)
    return [organ for organ in mentioned if organ in _LESION_ORGANS]


# Phrases by which a reply asserts a lesion exists, used only to catch a model
# contradicting a measured absence.
_PRESENCE_RE = re.compile(
    r"\b(?:there (?:is|appears to be)|i can see|shows?|reveals?|demonstrates?|"
    r"consistent with|identified|visible|present)\b[^.?!]{0,60}\b"
    r"(?:lesion|tumou?r|mass|carcinoma|neoplasm|nodule)\b",
    re.IGNORECASE,
)

_ABSENCE_RE = re.compile(
    r"\bno\b[^.?!]{0,40}\b(?:lesion|tumou?r|mass|carcinoma|neoplasm|nodule)\b"
    r"|\b(?:lesion|tumou?r|mass)\b[^.?!]{0,30}\b(?:absent|not present|not seen)\b",
    re.IGNORECASE,
)


def reconcile_lesion_answer(
    reply: str,
    *,
    absent_displays: Sequence[str],
    present_displays: Sequence[str],
) -> str:
    """Stop a reply contradicting what the segmentation measured.

    The prompt already forbids this, but a small local model asked "where is the
    pancreatic lesion?" will sometimes produce one anyway — and a fabricated
    tumour is the single worst output this product can emit. When the reply
    contradicts a measured absence, it is replaced rather than patched: a
    corrected sentence bolted onto invented prose still reads as a finding.
    """
    text = str(reply or "").strip()
    if not text:
        return text

    plain = _strip_markdown(text)

    # Absence is checked first and wins: "there is no pancreatic lesion" also
    # matches the presence pattern ("there is ... lesion"), so reading presence
    # first would score a correct denial as a claim and rewrite a good answer.
    denies = bool(_ABSENCE_RE.search(plain))
    asserts = bool(_PRESENCE_RE.search(plain)) and not denies

    if absent_displays and not present_displays:
        if asserts:
            names = ", ".join(absent_displays)
            return (
                f"There is no {names} in this case. The segmentation contains no "
                f"voxels for that class, so nothing is marked as a lesion here — "
                "any region you are looking at is normal anatomy or a different "
                "labelled organ.\n\n"
                "Would you like me to isolate the pancreas in the viewer so you "
                "can look through it slice by slice?"
            )

    if present_displays and denies:
        names = ", ".join(present_displays)
        return (
            f"This case does contain a {names} in the segmentation. Let me give "
            "you the measured details rather than the summary above.\n\n"
            "Which would help more — its size and location, or the structures it "
            "sits against?"
        )

    return text


# Facts are written to be read by the model, not by the user: the lesion ones
# carry a "SEGMENTATION FACT:" marker so the prompt can point at them, and the
# unavailable case carries an instruction. Anything appended to a user-visible
# reply has to be cleaned of both, or the scaffolding shows through.
_FACT_PREFIX_RE = re.compile(r"^\s*SEGMENTATION FACT:\s*", re.IGNORECASE)

_INSTRUCTION_MARKERS = ("say the", "do not state", "do not guess")


def presentable_fact(fact: str) -> str:
    """A fact sentence safe to show the user, or "" if it is instruction-only."""
    text = _FACT_PREFIX_RE.sub("", str(fact or "")).strip()
    if not text:
        return ""
    if any(marker in text.lower() for marker in _INSTRUCTION_MARKERS):
        return ""
    return text[0].upper() + text[1:]


# ---------------------------------------------------------------------------
# Inventory and slice-level questions
#
# "What are the segmentation values of this case and how many structures are
# there?" and "What is the slice level of the pancreas head?" both have exact
# answers in the labelmap, and both were answered with nothing.
# ---------------------------------------------------------------------------

_INVENTORY_WORDS = (
    "how many structures", "how many organs", "how many segment",
    "what structures", "which structures", "list the structures",
    "list structures", "segmentation values", "segmentation value",
    "what is segmented", "what's segmented", "all the structures",
    "structure count", "every structure", "all organs", "what organs",
)

_SLICE_WORDS = (
    "slice level", "slice number", "which slice", "what slice", "slice range",
    "slice index", "axial level", "what level", "which level", "z level",
)


def asks_for_inventory(message: str) -> bool:
    """Whether the question asks what the segmentation contains."""
    norm = normalize(message)
    return any(phrase in norm for phrase in _INVENTORY_WORDS)


def asks_for_slice_level(message: str) -> bool:
    """Whether the question asks where a structure sits along the scan."""
    norm = normalize(message)
    if any(phrase in norm for phrase in _SLICE_WORDS):
        return True
    # "where is the pancreas head" is a slice-level question in a CT viewer.
    return bool(re.search(r"\bwhere\s+(?:is|are|does)\b", norm)) and bool(organs_mentioned(message))


# ---------------------------------------------------------------------------
# Does this question concern the open case at all?
#
# Detecting individual question shapes (lesion / inventory / slice / volume) can
# only ever answer the shapes someone thought to enumerate. Anything else fell
# through to a model with no case data — which is where the blank and invented
# answers came from. This test is deliberately broad: when in doubt, give the
# model the case inventory and let it decide what is relevant.
# ---------------------------------------------------------------------------

_CASE_WORDS = (
    "case", "scan", "ct", "segmentation", "segmented", "structure", "structures",
    "organ", "organs", "volume", "slice", "level", "patient", "study", "image",
    "images", "mask", "label", "value", "values", "measurement", "measurements",
    "here", "shown", "this", "biggest", "largest", "smallest", "count",
)


def touches_case(message: str) -> bool:
    """Whether the open case could plausibly be the subject of this question."""
    norm = normalize(message)
    if organs_mentioned(message):
        return True
    if asks_about_lesion(message) or asks_for_inventory(message):
        return True
    if asks_for_slice_level(message) or asks_for_measurement(message):
        return True
    return any(re.search(rf"\b{re.escape(word)}\b", norm) for word in _CASE_WORDS)


def is_only_a_question(reply: str) -> bool:
    """Whether the reply asks something without answering anything.

    Small local models sometimes emit the closing question and nothing else —
    "What is the window preset used to display the pancreatic lesion?" in place
    of the volume that was asked for. The prompt tells them to end with a
    question, and they occasionally deliver only the ending. A reply with no
    declarative sentence has not answered, whatever else it did.
    """
    text = _strip_markdown(reply).strip()
    if not text:
        return False
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if not sentences:
        return False
    return all(sentence.endswith("?") for sentence in sentences)


def answer_from_facts(facts: Sequence[str]) -> str:
    """Build a plain answer out of measured facts, for when the model gives none."""
    shown = [presentable_fact(fact) for fact in facts]
    return " ".join(part for part in shown if part).strip()
