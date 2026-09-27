"""
Fallback Architecture for MedIA-Agentic-AI Models
Used when dynamic_network_architectures package is not available

Note: The actual models use nnU-Net's ResidualEncoderUNet.
This is a simplified fallback for compatibility.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import List, Tuple, Optional


class ConvBlock(nn.Module):
    """Basic convolution block with normalization and activation."""
    
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int = 3,
        padding: int = 1,
        use_3d: bool = True
    ):
        super().__init__()
        
        Conv = nn.Conv3d if use_3d else nn.Conv2d
        Norm = nn.InstanceNorm3d if use_3d else nn.InstanceNorm2d
        
        self.conv = Conv(in_channels, out_channels, kernel_size, padding=padding, bias=True)
        self.norm = Norm(out_channels, eps=1e-5, affine=True)
        self.activation = nn.LeakyReLU(inplace=True)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.activation(self.norm(self.conv(x)))


class ResidualBlock(nn.Module):
    """Residual block with two convolutions."""
    
    def __init__(self, channels: int, use_3d: bool = True):
        super().__init__()
        
        self.conv1 = ConvBlock(channels, channels, use_3d=use_3d)
        self.conv2 = ConvBlock(channels, channels, use_3d=use_3d)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        out = self.conv1(x)
        out = self.conv2(out)
        return out + residual


class EncoderBlock(nn.Module):
    """Encoder block: convolutions + downsampling."""
    
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        num_blocks: int = 1,
        use_3d: bool = True
    ):
        super().__init__()
        
        Conv = nn.Conv3d if use_3d else nn.Conv2d
        
        # Initial convolution to change channels
        self.initial_conv = ConvBlock(in_channels, out_channels, use_3d=use_3d)
        
        # Residual blocks
        self.res_blocks = nn.ModuleList([
            ResidualBlock(out_channels, use_3d=use_3d)
            for _ in range(num_blocks - 1)
        ])
        
        # Downsampling
        self.downsample = Conv(out_channels, out_channels, kernel_size=2, stride=2, bias=True)
    
    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        # Convolutions
        out = self.initial_conv(x)
        for block in self.res_blocks:
            out = block(out)
        
        # Store for skip connection
        skip = out
        
        # Downsample
        out = self.downsample(out)
        
        return out, skip


class DecoderBlock(nn.Module):
    """Decoder block: upsampling + convolutions."""
    
    def __init__(
        self,
        in_channels: int,
        skip_channels: int,
        out_channels: int,
        use_3d: bool = True
    ):
        super().__init__()
        
        ConvTranspose = nn.ConvTranspose3d if use_3d else nn.ConvTranspose2d
        
        # Upsampling
        self.upsample = ConvTranspose(in_channels, out_channels, kernel_size=2, stride=2, bias=True)
        
        # Convolution after concatenation
        self.conv = ConvBlock(out_channels + skip_channels, out_channels, use_3d=use_3d)
    
    def forward(self, x: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        # Upsample
        out = self.upsample(x)
        
        # Handle size mismatch
        if out.shape[2:] != skip.shape[2:]:
            out = F.interpolate(out, size=skip.shape[2:], mode='trilinear', align_corners=False)
        
        # Concatenate with skip connection
        out = torch.cat([out, skip], dim=1)
        
        # Convolution
        out = self.conv(out)
        
        return out


class MediaAgenticUNet(nn.Module):
    """
    Fallback U-Net architecture for MedIA-Agentic models.
    
    This is a simplified version of nnU-Net's ResidualEncoderUNet.
    Use this when the dynamic_network_architectures package is not available.
    
    Args:
        in_channels: Number of input channels (1 for CT)
        num_classes: Number of output classes
        features: Feature channels at each stage
        blocks_per_stage: Number of residual blocks per encoder stage
    """
    
    def __init__(
        self,
        in_channels: int = 1,
        num_classes: int = 18,
        features: List[int] = [32, 64, 128, 256, 320, 320],
        blocks_per_stage: List[int] = [1, 3, 4, 6, 6, 6],
        use_3d: bool = True
    ):
        super().__init__()
        
        self.in_channels = in_channels
        self.num_classes = num_classes
        self.features = features
        self.n_stages = len(features)
        
        # Encoder
        self.encoders = nn.ModuleList()
        
        prev_channels = in_channels
        for i, (feat, blocks) in enumerate(zip(features, blocks_per_stage)):
            self.encoders.append(
                EncoderBlock(prev_channels, feat, num_blocks=blocks, use_3d=use_3d)
            )
            prev_channels = feat
        
        # Decoder
        self.decoders = nn.ModuleList()
        
        for i in range(self.n_stages - 1):
            in_feat = features[self.n_stages - 1 - i]
            skip_feat = features[self.n_stages - 2 - i]
            out_feat = skip_feat
            
            self.decoders.append(
                DecoderBlock(in_feat, skip_feat, out_feat, use_3d=use_3d)
            )
        
        # Output layer
        Conv = nn.Conv3d if use_3d else nn.Conv2d
        self.output_conv = Conv(features[0], num_classes, kernel_size=1, bias=True)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # Encoder path
        skips = []
        out = x
        
        for encoder in self.encoders:
            out, skip = encoder(out)
            skips.append(skip)
        
        # Remove last skip (not used)
        skips = skips[:-1]
        
        # Decoder path
        for decoder, skip in zip(self.decoders, reversed(skips)):
            out = decoder(out, skip)
        
        # Output
        out = self.output_conv(out)
        
        return out
    
    def get_output_channels(self) -> int:
        """Return number of output classes."""
        return self.num_classes


def create_model_from_config(config) -> MediaAgenticUNet:
    """
    Create a MediaAgenticUNet from a ModelConfig.
    
    Args:
        config: ModelConfig instance
        
    Returns:
        Instantiated model
    """
    return MediaAgenticUNet(
        in_channels=config.in_channels,
        num_classes=config.num_classes,
        features=list(config.features_per_stage),
        blocks_per_stage=list(config.n_blocks_per_stage),
        use_3d=True
    )