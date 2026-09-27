"""
Configuration for MedIA-Agentic-AI Models (cads551, cads552)
Based on nnU-Net ResidualEncoderUNet architecture
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class ModelConfig:
    """Configuration for MedIA-Agentic nnU-Net models."""
    
    # Model identification
    name: str
    model_id: str
    
    # Architecture (nnU-Net ResidualEncoderUNet)
    n_stages: int = 6
    features_per_stage: Tuple[int, ...] = (32, 64, 128, 256, 320, 320)
    n_blocks_per_stage: Tuple[int, ...] = (1, 3, 4, 6, 6, 6)
    n_conv_per_stage_decoder: Tuple[int, ...] = (1, 1, 1, 1, 1)
    
    # Input/Output
    in_channels: int = 1  # CT single channel
    num_classes: int = 18
    
    # Preprocessing
    patch_size: Tuple[int, int, int] = (192, 192, 192)
    spacing: Tuple[float, float, float] = (1.5, 1.5, 1.5)
    
    # CT Normalization (from nnU-Net plans)
    ct_mean: float = -454.4
    ct_std: float = 449.75
    ct_min_clip: float = -1018.0  # percentile_00_5
    ct_max_clip: float = 298.0    # percentile_99_5
    
    # Labels
    labels: Dict[str, int] = field(default_factory=dict)
    
    # Inference settings
    overlap: float = 0.5
    mirror_axes: Optional[Tuple[int, ...]] = None  # No mirroring (nnUNetTrainerNoMirroring)
    
    # Weight paths on JHU server
    weights_path: str = ""
    optimized_weights_path: str = ""


# cads551: Multi-organ segmentation (TotalSeg style)
CADS551_CONFIG = ModelConfig(
    name="MedIA-Agentic cads551",
    model_id="cads551",
    num_classes=18,
    labels={
        "background": 0,
        "spleen": 1,
        "kidney_right": 2,
        "kidney_left": 3,
        "gallbladder": 4,
        "liver": 5,
        "stomach": 6,
        "aorta": 7,
        "inferior_vena_cava": 8,
        "portal_vein_and_splenic_vein": 9,
        "pancreas": 10,
        "adrenal_gland_right": 11,
        "adrenal_gland_left": 12,
        "lung_upper_lobe_left": 13,
        "lung_lower_lobe_left": 14,
        "lung_upper_lobe_right": 15,
        "lung_middle_lobe_right": 16,
        "lung_lower_lobe_right": 17,
    },
    weights_path="/home/visitor/bodymaps_models/media_agentic/cads551/model.pth",
    optimized_weights_path="/home/visitor/bodymaps_models/media_agentic/quantized/cads551_optimized.pth",
)


# cads552: Vertebrae segmentation
CADS552_CONFIG = ModelConfig(
    name="MedIA-Agentic cads552",
    model_id="cads552",
    num_classes=25,
    labels={
        "background": 0,
        "vertebrae_L5": 1,
        "vertebrae_L4": 2,
        "vertebrae_L3": 3,
        "vertebrae_L2": 4,
        "vertebrae_L1": 5,
        "vertebrae_T12": 6,
        "vertebrae_T11": 7,
        "vertebrae_T10": 8,
        "vertebrae_T9": 9,
        "vertebrae_T8": 10,
        "vertebrae_T7": 11,
        "vertebrae_T6": 12,
        "vertebrae_T5": 13,
        "vertebrae_T4": 14,
        "vertebrae_T3": 15,
        "vertebrae_T2": 16,
        "vertebrae_T1": 17,
        "vertebrae_C7": 18,
        "vertebrae_C6": 19,
        "vertebrae_C5": 20,
        "vertebrae_C4": 21,
        "vertebrae_C3": 22,
        "vertebrae_C2": 23,
        "vertebrae_C1": 24,
    },
    weights_path="/home/visitor/bodymaps_models/media_agentic/cads552/model.pth",
    optimized_weights_path="/home/visitor/bodymaps_models/media_agentic/quantized/cads552_optimized.pth",
)


# Dictionary for easy access
AVAILABLE_MODELS = {
    "cads551": CADS551_CONFIG,
    "cads552": CADS552_CONFIG,
}


def get_config(model_id: str) -> ModelConfig:
    """Get configuration for a specific model."""
    if model_id not in AVAILABLE_MODELS:
        raise ValueError(f"Unknown model: {model_id}. Available: {list(AVAILABLE_MODELS.keys())}")
    return AVAILABLE_MODELS[model_id]