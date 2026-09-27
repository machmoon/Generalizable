"""
Quantization utilities for MedIA-Agentic-AI Models
Supports creating optimized model files for faster inference
"""

import torch
import torch.nn as nn
from pathlib import Path
from typing import Optional, Dict, Any
import os

from .config import ModelConfig


class MediaAgenticQuantizer:
    """
    Quantization and optimization utilities for MedIA-Agentic models.
    
    Supports:
    - Removing training state (optimizer, etc.) for smaller files
    - Dynamic INT8 quantization for CPU inference
    - FP16 conversion for GPU inference
    """
    
    def __init__(self, config: ModelConfig):
        self.config = config
    
    def optimize_checkpoint(
        self,
        input_path: str,
        output_path: str
    ) -> Dict[str, Any]:
        """
        Create optimized checkpoint with only inference-required data.
        
        Args:
            input_path: Path to original checkpoint
            output_path: Path to save optimized checkpoint
            
        Returns:
            Info about size reduction
        """
        # Load original
        checkpoint = torch.load(input_path, map_location='cpu', weights_only=False)
        
        # Keep only essential keys
        optimized = {
            'network_weights': checkpoint['network_weights'],
            'init_args': checkpoint.get('init_args', {}),
        }
        
        # Save
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        torch.save(optimized, output_path)
        
        # Calculate sizes
        orig_size = os.path.getsize(input_path)
        new_size = os.path.getsize(output_path)
        
        return {
            'original_size_mb': orig_size / (1024 * 1024),
            'optimized_size_mb': new_size / (1024 * 1024),
            'reduction_percent': (1 - new_size / orig_size) * 100
        }
    
    def quantize_dynamic_int8(
        self,
        model: nn.Module
    ) -> nn.Module:
        """
        Apply dynamic INT8 quantization (CPU only).
        
        Args:
            model: PyTorch model
            
        Returns:
            Quantized model
        """
        quantized = torch.quantization.quantize_dynamic(
            model,
            {nn.Linear, nn.Conv3d},
            dtype=torch.qint8
        )
        return quantized
    
    def convert_to_fp16(
        self,
        model: nn.Module
    ) -> nn.Module:
        """
        Convert model to FP16 (half precision).
        
        Args:
            model: PyTorch model
            
        Returns:
            FP16 model
        """
        return model.half()
    
    def save_quantized_weights(
        self,
        model: nn.Module,
        output_path: str,
        include_config: bool = True
    ):
        """
        Save quantized model weights.
        
        Args:
            model: Quantized model
            output_path: Path to save
            include_config: Whether to include model config
        """
        save_dict = {
            'network_weights': model.state_dict(),
        }
        
        if include_config:
            save_dict['config'] = {
                'name': self.config.name,
                'model_id': self.config.model_id,
                'num_classes': self.config.num_classes,
                'patch_size': self.config.patch_size,
            }
        
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        torch.save(save_dict, output_path)
        print(f"Saved quantized weights to: {output_path}")


def create_optimized_models(base_path: str, output_path: str):
    """
    Create optimized versions of all MedIA-Agentic models.
    
    Args:
        base_path: Path containing cads551/ and cads552/ folders
        output_path: Path for output quantized/ folder
    """
    from .config import CADS551_CONFIG, CADS552_CONFIG
    
    configs = [
        ('cads551', CADS551_CONFIG),
        ('cads552', CADS552_CONFIG),
    ]
    
    os.makedirs(output_path, exist_ok=True)
    
    for model_id, config in configs:
        print(f"\nOptimizing {model_id}...")
        
        input_file = os.path.join(base_path, model_id, 'model.pth')
        output_file = os.path.join(output_path, f'{model_id}_optimized.pth')
        
        if not os.path.exists(input_file):
            print(f"  Skipping: {input_file} not found")
            continue
        
        quantizer = MediaAgenticQuantizer(config)
        info = quantizer.optimize_checkpoint(input_file, output_file)
        
        print(f"  Original: {info['original_size_mb']:.1f} MB")
        print(f"  Optimized: {info['optimized_size_mb']:.1f} MB")
        print(f"  Reduction: {info['reduction_percent']:.1f}%")
    
    print("\nDone!")