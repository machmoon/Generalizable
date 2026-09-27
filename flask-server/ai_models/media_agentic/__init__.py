"""
MedIA-Agentic-AI Integration for BodyMaps
==========================================

Models:
- cads551: Multi-organ segmentation (18 classes)
- cads552: Vertebrae segmentation (25 classes)

Usage:
    from ai_models.media_agentic import (
        load_cads551,
        load_cads552,
        CADS551_CONFIG,
        CADS552_CONFIG,
    )
    
    # Load model
    model = load_cads551()
    
    # Run inference
    from ai_models.media_agentic import MediaAgenticInference
    inference = MediaAgenticInference(model, CADS551_CONFIG)
    segmentation = inference.predict(ct_volume)
"""

# Configuration
from .config import (
    ModelConfig,
    CADS551_CONFIG,
    CADS552_CONFIG,
    AVAILABLE_MODELS,
    get_config,
)

# Model loading
from .model_loader import (
    MediaAgenticLoader,
    load_cads551,
    load_cads552,
    load_model_by_id,
)

# Inference
from .inference import (
    MediaAgenticInference,
    CTPreprocessor,
    SlidingWindowInference,
)

# Quantization
from .quantization import (
    MediaAgenticQuantizer,
    create_optimized_models,
)

# Utilities
from .utils import (
    load_nifti,
    save_nifti,
    preprocess_ct,
    benchmark_inference,
    get_model_info,
    print_model_summary,
)

# Version
__version__ = "1.0.0"
__author__ = "Ahmad Durre Rehman"

# Public API
__all__ = [
    # Config
    "ModelConfig",
    "CADS551_CONFIG",
    "CADS552_CONFIG",
    "AVAILABLE_MODELS",
    "get_config",
    # Loading
    "MediaAgenticLoader",
    "load_cads551",
    "load_cads552",
    "load_model_by_id",
    # Inference
    "MediaAgenticInference",
    "CTPreprocessor",
    "SlidingWindowInference",
    # Quantization
    "MediaAgenticQuantizer",
    "create_optimized_models",
    # Utils
    "load_nifti",
    "save_nifti",
    "preprocess_ct",
    "benchmark_inference",
    "get_model_info",
    "print_model_summary",
]