"""
Benchmark Runner for MedIA-Agentic-AI Models
Measures inference time, memory usage, and model statistics
"""

import os
import sys
import time
import json
import numpy as np
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def get_system_info() -> Dict:
    """Collect system information."""
    import platform
    
    info = {
        "timestamp": datetime.now().isoformat(),
        "platform": platform.system(),
        "python_version": platform.python_version(),
    }
    
    try:
        import torch
        info["pytorch_version"] = torch.__version__
        info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["gpu_name"] = torch.cuda.get_device_name(0)
    except ImportError:
        info["pytorch_version"] = "not installed"
    
    return info


def benchmark_model_loading(model_id: str, weights_path: str) -> Dict:
    """Benchmark model loading time."""
    import torch
    from ai_models.media_agentic import MediaAgenticLoader, get_config
    
    config = get_config(model_id)
    
    # Clear cache
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    
    # Time loading
    start = time.time()
    loader = MediaAgenticLoader(config)
    checkpoint = loader.load_checkpoint(weights_path)
    load_time = time.time() - start
    
    # Get file size
    file_size_mb = os.path.getsize(weights_path) / (1024 * 1024)
    
    return {
        "model_id": model_id,
        "load_time_seconds": round(load_time, 3),
        "file_size_mb": round(file_size_mb, 1),
        "num_classes": len(config.labels),
    }


def benchmark_inference_speed(
    model_id: str,
    weights_path: str,
    num_runs: int = 5
) -> Dict:
    """Benchmark inference speed with synthetic data."""
    import torch
    from ai_models.media_agentic import benchmark_inference, get_config
    
    config = get_config(model_id)
    
    # Load checkpoint and get weights
    checkpoint = torch.load(weights_path, map_location='cpu', weights_only=False)
    
    # Create a simple model for benchmarking
    from ai_models.media_agentic.architecture import MediaAgenticUNet
    
    model = MediaAgenticUNet(
        in_channels=1,
        num_classes=config.num_classes,
    )
    
    # Benchmark with small input (to be fast)
    results = benchmark_inference(
        model,
        input_shape=(1, 1, 64, 64, 64),
        num_runs=num_runs,
        device=torch.device('cpu')  # Use CPU for consistency
    )
    
    return {
        "model_id": model_id,
        "input_shape": [1, 1, 64, 64, 64],
        "mean_time_seconds": round(results['mean_time'], 4),
        "std_time_seconds": round(results['std_time'], 4),
        "num_runs": num_runs,
    }


def run_full_benchmark(models_path: str, output_dir: str = "./results") -> Dict:
    """Run complete benchmark suite."""
    
    print("=" * 60)
    print("MedIA-Agentic-AI Benchmark Suite")
    print("=" * 60)
    
    results = {
        "system_info": get_system_info(),
        "models": {}
    }
    
    models_path = Path(models_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    for model_id in ["cads551", "cads552"]:
        weights_file = models_path / model_id / "model.pth"
        
        if not weights_file.exists():
            print(f"\nSkipping {model_id}: weights not found")
            continue
        
        print(f"\nBenchmarking {model_id}...")
        
        model_results = {}
        
        # Loading benchmark
        try:
            model_results["loading"] = benchmark_model_loading(model_id, str(weights_file))
            print(f"  Load time: {model_results['loading']['load_time_seconds']}s")
        except Exception as e:
            print(f"  Loading failed: {e}")
            model_results["loading_error"] = str(e)
        
        # Inference benchmark
        try:
            model_results["inference"] = benchmark_inference_speed(model_id, str(weights_file))
            print(f"  Inference time: {model_results['inference']['mean_time_seconds']}s")
        except Exception as e:
            print(f"  Inference benchmark failed: {e}")
            model_results["inference_error"] = str(e)
        
        results["models"][model_id] = model_results
    
    # Save results
    output_file = output_dir / f"benchmark_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    print(f"\nResults saved to: {output_file}")
    
    return results


def generate_markdown_report(results: Dict) -> str:
    """Generate markdown report from results."""
    
    lines = [
        "# MedIA-Agentic-AI Benchmark Report",
        "",
        f"Generated: {results['system_info']['timestamp']}",
        "",
        "## System Information",
        "",
        f"- Python: {results['system_info']['python_version']}",
        f"- PyTorch: {results['system_info'].get('pytorch_version', 'N/A')}",
        f"- CUDA: {results['system_info'].get('cuda_available', False)}",
        "",
        "## Model Benchmarks",
        "",
    ]
    
    for model_id, data in results.get("models", {}).items():
        lines.append(f"### {model_id}")
        lines.append("")
        
        if "loading" in data:
            lines.append(f"- **File size**: {data['loading']['file_size_mb']} MB")
            lines.append(f"- **Load time**: {data['loading']['load_time_seconds']}s")
            lines.append(f"- **Classes**: {data['loading']['num_classes']}")
        
        if "inference" in data:
            lines.append(f"- **Inference time**: {data['inference']['mean_time_seconds']}s ± {data['inference']['std_time_seconds']}s")
        
        lines.append("")
    
    return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Run MedIA-Agentic benchmarks")
    parser.add_argument(
        "--models-path",
        default="/home/visitor/bodymaps_models/media_agentic",
        help="Path to model weights"
    )
    parser.add_argument(
        "--output-dir",
        default="./results",
        help="Output directory for results"
    )
    
    args = parser.parse_args()
    
    results = run_full_benchmark(args.models_path, args.output_dir)
    
    # Print report
    report = generate_markdown_report(results)
    print("\n" + report)