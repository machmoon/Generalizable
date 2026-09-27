"""
Inference Pipeline for MedIA-Agentic-AI Models
Handles CT preprocessing, sliding window inference, and post-processing
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
from typing import Tuple, Optional, List, Union
from pathlib import Path

from .config import ModelConfig


class CTPreprocessor:
    """
    CT image preprocessing following nnU-Net conventions.
    """
    
    def __init__(self, config: ModelConfig):
        self.config = config
    
    def normalize(self, volume: np.ndarray) -> np.ndarray:
        """
        Apply CT normalization (clip and z-score).
        
        Args:
            volume: Raw CT volume in HU
            
        Returns:
            Normalized volume
        """
        # Clip to intensity range
        volume = np.clip(volume, self.config.ct_min_clip, self.config.ct_max_clip)
        
        # Z-score normalization
        volume = (volume - self.config.ct_mean) / self.config.ct_std
        
        return volume.astype(np.float32)
    
    def preprocess(self, volume: np.ndarray) -> torch.Tensor:
        """
        Full preprocessing pipeline.
        
        Args:
            volume: Raw CT volume (D, H, W) or (H, W, D)
            
        Returns:
            Preprocessed tensor (1, 1, D, H, W)
        """
        # Normalize
        volume = self.normalize(volume)
        
        # Convert to tensor and add batch/channel dims
        tensor = torch.from_numpy(volume).float()
        tensor = tensor.unsqueeze(0).unsqueeze(0)  # (1, 1, D, H, W)
        
        return tensor


class SlidingWindowInference:
    """
    Sliding window inference for large 3D volumes.
    """
    
    def __init__(
        self,
        patch_size: Tuple[int, int, int] = (192, 192, 192),
        overlap: float = 0.5,
        batch_size: int = 1
    ):
        self.patch_size = patch_size
        self.overlap = overlap
        self.batch_size = batch_size
        self.step_size = tuple(int(p * (1 - overlap)) for p in patch_size)
    
    def _get_patch_positions(self, volume_shape: Tuple[int, ...]) -> List[Tuple[int, int, int]]:
        """Calculate patch starting positions."""
        positions = []
        
        for d in range(0, max(1, volume_shape[0] - self.patch_size[0] + 1), self.step_size[0]):
            for h in range(0, max(1, volume_shape[1] - self.patch_size[1] + 1), self.step_size[1]):
                for w in range(0, max(1, volume_shape[2] - self.patch_size[2] + 1), self.step_size[2]):
                    positions.append((d, h, w))
        
        # Add edge positions if needed
        if positions:
            last_d = max(0, volume_shape[0] - self.patch_size[0])
            last_h = max(0, volume_shape[1] - self.patch_size[1])
            last_w = max(0, volume_shape[2] - self.patch_size[2])
            
            if (last_d, last_h, last_w) not in positions:
                positions.append((last_d, last_h, last_w))
        else:
            positions.append((0, 0, 0))
        
        return positions
    
    def __call__(
        self,
        model: nn.Module,
        volume: torch.Tensor,
        device: torch.device
    ) -> torch.Tensor:
        """
        Run sliding window inference.
        
        Args:
            model: The segmentation model
            volume: Input tensor (1, 1, D, H, W)
            device: Computation device
            
        Returns:
            Segmentation output (1, C, D, H, W)
        """
        model.eval()
        volume = volume.to(device)
        
        _, _, D, H, W = volume.shape
        volume_shape = (D, H, W)
        
        # Check if volume is smaller than patch size
        if D <= self.patch_size[0] and H <= self.patch_size[1] and W <= self.patch_size[2]:
            # Pad if necessary
            pad_d = max(0, self.patch_size[0] - D)
            pad_h = max(0, self.patch_size[1] - H)
            pad_w = max(0, self.patch_size[2] - W)
            
            if pad_d > 0 or pad_h > 0 or pad_w > 0:
                volume = F.pad(volume, (0, pad_w, 0, pad_h, 0, pad_d), mode='constant', value=0)
            
            with torch.no_grad():
                output = model(volume)
            
            # Crop back to original size
            output = output[:, :, :D, :H, :W]
            return output
        
        # Get patch positions
        positions = self._get_patch_positions(volume_shape)
        
        # Initialize output and count tensors
        with torch.no_grad():
            # Get number of output channels from a test forward
            test_patch = volume[:, :, :self.patch_size[0], :self.patch_size[1], :self.patch_size[2]]
            if test_patch.shape[2] < self.patch_size[0]:
                test_patch = F.pad(test_patch, (0, 0, 0, 0, 0, self.patch_size[0] - test_patch.shape[2]))
            test_output = model(test_patch)
            num_classes = test_output.shape[1]
        
        output_sum = torch.zeros((1, num_classes, D, H, W), device=device)
        count = torch.zeros((1, 1, D, H, W), device=device)
        
        # Process patches
        with torch.no_grad():
            for d, h, w in positions:
                # Extract patch
                d_end = min(d + self.patch_size[0], D)
                h_end = min(h + self.patch_size[1], H)
                w_end = min(w + self.patch_size[2], W)
                
                patch = volume[:, :, d:d_end, h:h_end, w:w_end]
                
                # Pad if necessary
                pad_d = self.patch_size[0] - patch.shape[2]
                pad_h = self.patch_size[1] - patch.shape[3]
                pad_w = self.patch_size[2] - patch.shape[4]
                
                if pad_d > 0 or pad_h > 0 or pad_w > 0:
                    patch = F.pad(patch, (0, pad_w, 0, pad_h, 0, pad_d), mode='constant', value=0)
                
                # Forward pass
                patch_output = model(patch)
                
                # Crop padding
                patch_output = patch_output[:, :, :d_end-d, :h_end-h, :w_end-w]
                
                # Accumulate
                output_sum[:, :, d:d_end, h:h_end, w:w_end] += patch_output
                count[:, :, d:d_end, h:h_end, w:w_end] += 1
        
        # Average overlapping regions
        output = output_sum / count.clamp(min=1)
        
        return output


class MediaAgenticInference:
    """
    Complete inference pipeline for MedIA-Agentic models.
    """
    
    def __init__(
        self,
        model: nn.Module,
        config: ModelConfig,
        device: Optional[torch.device] = None
    ):
        self.model = model
        self.config = config
        self.device = device or torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        self.preprocessor = CTPreprocessor(config)
        self.sliding_window = SlidingWindowInference(
            patch_size=config.patch_size,
            overlap=config.overlap
        )
        
        self.model.to(self.device)
        self.model.eval()
    
    def predict(
        self,
        volume: Union[np.ndarray, torch.Tensor],
        return_probabilities: bool = False
    ) -> Union[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
        """
        Run full inference pipeline.
        
        Args:
            volume: Input CT volume (numpy array or tensor)
            return_probabilities: Whether to return class probabilities
            
        Returns:
            Segmentation mask (and optionally probabilities)
        """
        # Preprocess
        if isinstance(volume, np.ndarray):
            tensor = self.preprocessor.preprocess(volume)
        else:
            tensor = volume
        
        # Run inference
        with torch.no_grad():
            output = self.sliding_window(self.model, tensor, self.device)
        
        # Get probabilities
        probabilities = F.softmax(output, dim=1)
        
        # Get segmentation mask
        segmentation = torch.argmax(probabilities, dim=1)
        
        # Convert to numpy
        segmentation = segmentation.squeeze().cpu().numpy().astype(np.uint8)
        
        if return_probabilities:
            probs = probabilities.squeeze().cpu().numpy()
            return segmentation, probs
        
        return segmentation
    
    def predict_file(
        self,
        input_path: str,
        output_path: Optional[str] = None
    ) -> np.ndarray:
        """
        Run inference on a NIfTI file.
        
        Args:
            input_path: Path to input .nii.gz file
            output_path: Optional path to save output
            
        Returns:
            Segmentation mask
        """
        try:
            import nibabel as nib
        except ImportError:
            raise ImportError("nibabel required for NIfTI file support: pip install nibabel")
        
        # Load
        img = nib.load(input_path)
        volume = img.get_fdata().astype(np.float32)
        
        # Predict
        segmentation = self.predict(volume)
        
        # Save if requested
        if output_path:
            seg_img = nib.Nifti1Image(segmentation, img.affine, img.header)
            nib.save(seg_img, output_path)
            print(f"Saved segmentation to: {output_path}")
        
        return segmentation
    
    def get_label_name(self, label_id: int) -> str:
        """Get the name of a label by its ID."""
        for name, id_ in self.config.labels.items():
            if id_ == label_id:
                return name
        return f"unknown_{label_id}"