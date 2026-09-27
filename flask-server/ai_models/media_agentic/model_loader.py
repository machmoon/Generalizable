"""
Model Loader for MedIA-Agentic-AI Models (nnU-Net based)
Handles loading checkpoints from JHU server
"""

import torch
import torch.nn as nn
from pathlib import Path
from typing import Optional, Dict, Any, Union

from .config import ModelConfig, CADS551_CONFIG, CADS552_CONFIG, get_config


class MediaAgenticLoader:
    """
    Loader for MedIA-Agentic nnU-Net models.
    Handles checkpoint loading and model instantiation.
    """
    
    def __init__(self, config: Optional[ModelConfig] = None):
        """
        Initialize the loader.
        
        Args:
            config: Model configuration. If None, must specify when loading.
        """
        self.config = config
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    def load_checkpoint(
        self,
        weights_path: str,
        map_location: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Load a checkpoint file.
        
        Args:
            weights_path: Path to .pth file
            map_location: Device to load to ('cpu', 'cuda', etc.)
            
        Returns:
            Checkpoint dictionary
        """
        path = Path(weights_path)
        if not path.exists():
            raise FileNotFoundError(f"Weights not found: {weights_path}")
        
        if map_location is None:
            map_location = 'cpu'  # Load to CPU first, then move to device
        
        print(f"Loading checkpoint from: {weights_path}")
        checkpoint = torch.load(weights_path, map_location=map_location, weights_only=False)
        print(f"Checkpoint loaded successfully")
        
        return checkpoint
    
    def get_network_weights(self, checkpoint: Dict[str, Any]) -> Dict[str, torch.Tensor]:
        """
        Extract network weights from checkpoint.
        
        Args:
            checkpoint: Full checkpoint dictionary
            
        Returns:
            State dict with network weights
        """
        if 'network_weights' in checkpoint:
            return checkpoint['network_weights']
        elif 'state_dict' in checkpoint:
            return checkpoint['state_dict']
        elif 'model_state_dict' in checkpoint:
            return checkpoint['model_state_dict']
        else:
            # Assume checkpoint is already a state dict
            return checkpoint
    
    def get_model_config_from_checkpoint(self, checkpoint: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract model configuration from checkpoint.
        
        Args:
            checkpoint: Full checkpoint dictionary
            
        Returns:
            Configuration dictionary
        """
        if 'init_args' in checkpoint:
            return checkpoint['init_args']
        return {}
    
    def load_model(
        self,
        weights_path: Optional[str] = None,
        use_optimized: bool = False,
        device: Optional[torch.device] = None
    ) -> nn.Module:
        """
        Load model with weights.
        
        Args:
            weights_path: Path to weights. If None, uses config path.
            use_optimized: Whether to use optimized/quantized weights.
            device: Device to load model to.
            
        Returns:
            Loaded PyTorch model
        """
        if self.config is None:
            raise ValueError("Config must be provided to load model")
        
        # Determine weights path
        if weights_path is None:
            if use_optimized:
                weights_path = self.config.optimized_weights_path
            else:
                weights_path = self.config.weights_path
        
        if device is None:
            device = self.device
        
        # Load checkpoint
        checkpoint = self.load_checkpoint(weights_path, map_location='cpu')
        
        # Get network weights
        state_dict = self.get_network_weights(checkpoint)
        
        # Create model using dynamic import (nnU-Net style)
        model = self._create_nnunet_model(checkpoint)
        
        # Load weights
        model.load_state_dict(state_dict)
        
        # Move to device and set to eval mode
        model = model.to(device)
        model.eval()
        
        print(f"Model loaded on {device}")
        return model
    
    def _create_nnunet_model(self, checkpoint: Dict[str, Any]) -> nn.Module:
        """
        Create nnU-Net model from checkpoint configuration.
        
        Args:
            checkpoint: Checkpoint containing init_args
            
        Returns:
            Instantiated model (without weights)
        """
        try:
            # Try to use dynamic_network_architectures if available
            from dynamic_network_architectures.architectures.unet import ResidualEncoderUNet
            
            init_args = checkpoint.get('init_args', {})
            plans = init_args.get('plans', {})
            config_name = init_args.get('configuration', '3d_fullres')
            arch_config = plans.get('configurations', {}).get(config_name, {}).get('architecture', {})
            arch_kwargs = arch_config.get('arch_kwargs', {})
            
            # Get number of input/output channels
            dataset_json = init_args.get('dataset_json', {})
            num_input_channels = len(dataset_json.get('channel_names', {'0': 'CT'}))
            num_output_channels = len(dataset_json.get('labels', {}))
            
            # Build model
            model = ResidualEncoderUNet(
                input_channels=num_input_channels,
                n_stages=arch_kwargs.get('n_stages', 6),
                features_per_stage=arch_kwargs.get('features_per_stage', [32, 64, 128, 256, 320, 320]),
                conv_op=nn.Conv3d,
                kernel_sizes=arch_kwargs.get('kernel_sizes', [[3,3,3]]*6),
                strides=arch_kwargs.get('strides', [[1,1,1]] + [[2,2,2]]*5),
                n_blocks_per_stage=arch_kwargs.get('n_blocks_per_stage', [1, 3, 4, 6, 6, 6]),
                num_classes=num_output_channels,
                n_conv_per_stage_decoder=arch_kwargs.get('n_conv_per_stage_decoder', [1, 1, 1, 1, 1]),
                conv_bias=arch_kwargs.get('conv_bias', True),
                norm_op=nn.InstanceNorm3d,
                norm_op_kwargs=arch_kwargs.get('norm_op_kwargs', {'eps': 1e-5, 'affine': True}),
                dropout_op=None,
                nonlin=nn.LeakyReLU,
                nonlin_kwargs=arch_kwargs.get('nonlin_kwargs', {'inplace': True}),
            )
            
            print(f"Created ResidualEncoderUNet with {num_output_channels} classes")
            return model
            
        except ImportError:
            print("dynamic_network_architectures not found, using fallback")
            return self._create_fallback_model(checkpoint)
    
    def _create_fallback_model(self, checkpoint: Dict[str, Any]) -> nn.Module:
        """
        Create a simple wrapper model when nnU-Net package is not available.
        This loads weights directly into a generic container.
        """
        from .architecture import MediaAgenticUNet
        
        init_args = checkpoint.get('init_args', {})
        dataset_json = init_args.get('dataset_json', {})
        num_classes = len(dataset_json.get('labels', {}))
        
        # Use our fallback architecture
        model = MediaAgenticUNet(
            in_channels=1,
            num_classes=num_classes,
            features=[32, 64, 128, 256, 320, 320]
        )
        
        return model


def load_cads551(
    weights_path: Optional[str] = None,
    use_optimized: bool = False,
    device: Optional[torch.device] = None
) -> nn.Module:
    """
    Convenience function to load cads551 model.
    
    Args:
        weights_path: Optional custom weights path
        use_optimized: Use optimized weights (smaller file)
        device: Target device
        
    Returns:
        Loaded model ready for inference
    """
    loader = MediaAgenticLoader(CADS551_CONFIG)
    return loader.load_model(weights_path, use_optimized, device)


def load_cads552(
    weights_path: Optional[str] = None,
    use_optimized: bool = False,
    device: Optional[torch.device] = None
) -> nn.Module:
    """
    Convenience function to load cads552 model.
    """
    loader = MediaAgenticLoader(CADS552_CONFIG)
    return loader.load_model(weights_path, use_optimized, device)


def load_model_by_id(
    model_id: str,
    use_optimized: bool = False,
    device: Optional[torch.device] = None
) -> nn.Module:
    """
    Load any MedIA-Agentic model by ID.
    
    Args:
        model_id: 'cads551' or 'cads552'
        use_optimized: Use optimized weights
        device: Target device
        
    Returns:
        Loaded model
    """
    config = get_config(model_id)
    loader = MediaAgenticLoader(config)
    return loader.load_model(use_optimized=use_optimized, device=device)