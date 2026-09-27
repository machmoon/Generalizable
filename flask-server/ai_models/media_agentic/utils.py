"""
Utility functions for MedIA-Agentic-AI Models
"""

import numpy as np
import torch
from typing import Tuple, Optional, Dict, Any
from pathlib import Path
import time


def load_nifti(path: str) -> Tuple[np.ndarray, Any]:
    """
    Load a NIfTI file.
    
    Args:
        path: Path to .nii or .nii.gz file
        
    Returns:
        Tuple of (volume data, affine matrix)
    """
    try:
        import nibabel as nib
    except ImportError:
        raise ImportError("nibabel required: pip install nibabel")
    
    img = nib.load(path)
    return img.get_fdata().astype(np.float32), img.affine


def save_nifti(
    volume: np.ndarray,
    affine: np.ndarray,
    path: str
):
    """
    Save a volume as NIfTI file.
    
    Args:
        volume: 3D numpy array
        affine: Affine transformation matrix
        path: Output path
    """
    try:
        import nibabel as nib
    except ImportError:
        raise ImportError("nibabel required: pip install nibabel")
    
    img = nib.Nifti1Image(volume, affine)
    nib.save(img, path)
    print(f"Saved: {path}")


def preprocess_ct(
    volume: np.ndarray,
    clip_min: float = -1018.0,
    clip_max: float = 298.0,
    mean: float = -454.4,
    std: float = 449.75
) -> np.ndarray:
    """
    Preprocess CT volume with clipping and z-score normalization.
    
    Args:
        volume: Raw CT volume in HU
        clip_min: Minimum clip value (percentile 0.5)
        clip_max: Maximum clip value (percentile 99.5)
        mean: Mean for normalization
        std: Std for normalization
        
    Returns:
        Normalized volume
    """
    volume = np.clip(volume, clip_min, clip_max)
    volume = (volume - mean) / std
    return volume.astype(np.float32)


def benchmark_inference(
    model: torch.nn.Module,
    input_shape: Tuple[int, ...] = (1, 1, 96, 96, 96),
    num_runs: int = 10,
    warmup_runs: int = 3,
    device: Optional[torch.device] = None
) -> Dict[str, float]:
    """
    Benchmark model inference speed.
    
    Args:
        model: PyTorch model
        input_shape: Input tensor shape
        num_runs: Number of timed runs
        warmup_runs: Number of warmup runs
        device: Computation device
        
    Returns:
        Dictionary with timing statistics
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    model = model.to(device)
    model.eval()
    
    # Create dummy input
    dummy_input = torch.randn(*input_shape, device=device)
    
    # Warmup
    with torch.no_grad():
        for _ in range(warmup_runs):
            _ = model(dummy_input)
    
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    
    # Timed runs
    times = []
    with torch.no_grad():
        for _ in range(num_runs):
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            
            start = time.time()
            _ = model(dummy_input)
            
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            
            times.append(time.time() - start)
    
    return {
        'mean_time': np.mean(times),
        'std_time': np.std(times),
        'min_time': np.min(times),
        'max_time': np.max(times),
        'num_runs': num_runs,
    }


def get_model_info(checkpoint_path: str) -> Dict[str, Any]:
    """
    Extract model information from checkpoint.
    
    Args:
        checkpoint_path: Path to .pth file
        
    Returns:
        Dictionary with model info
    """
    checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
    
    info = {
        'keys': list(checkpoint.keys()),
    }
    
    if 'init_args' in checkpoint:
        init_args = checkpoint['init_args']
        
        if 'dataset_json' in init_args:
            dataset_json = init_args['dataset_json']
            info['labels'] = dataset_json.get('labels', {})
            info['num_classes'] = len(info['labels'])
            info['channel_names'] = dataset_json.get('channel_names', {})
        
        if 'configuration' in init_args:
            info['configuration'] = init_args['configuration']
        
        if 'plans' in init_args:
            plans = init_args['plans']
            info['dataset_name'] = plans.get('dataset_name', 'unknown')
            info['plans_name'] = plans.get('plans_name', 'unknown')
    
    if 'trainer_name' in checkpoint:
        info['trainer_name'] = checkpoint['trainer_name']
    
    return info


def print_model_summary(checkpoint_path: str):
    """Print a summary of model information."""
    info = get_model_info(checkpoint_path)
    
    print("=" * 50)
    print("Model Summary")
    print("=" * 50)
    
    for key, value in info.items():
        if key == 'labels':
            print(f"\n{key}:")
            for label_name, label_id in value.items():
                print(f"  {label_id}: {label_name}")
        else:
            print(f"{key}: {value}")
    
    print("=" * 50)