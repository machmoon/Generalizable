"""
Benchmark Runner for MedIA-Agentic-AI Models
Measures inference time, memory usage, and accuracy metrics
"""

import os
import sys
import time
import json
import torch
import numpy as np
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import psutil

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from ai_models.media_agentic import (
    MediaAgenticLoader,
    MediaAgenticInference,
    CADS551_CONFIG,
    CADS552_CONFIG,
    benchmark_inference
)


class BenchmarkRunner:
    """
    Comprehensive benchmark suite for MedIA-Agentic models.
    Measures performance across multiple metrics.
    """
    
    def __init__(self, output_dir: str = "./benchmark_results"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.results = {}
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
    def get_system_info(self) -> Dict:
        """Collect system information for benchmark context."""
        info = {
            "timestamp": datetime.now().isoformat(),
            "device": str(self.device),
            "cpu_count": psutil.cpu_count(),
            "ram_total_gb": round(psutil.virtual_memory().total / (1024**3), 2),
            "python_version": sys.version,
            "pytorch_version": torch.__version__,
        }
        
        if torch.cuda.is_available():
            info["gpu_name"] = torch.cuda.get_device_name(0)
            info["gpu_memory_gb"] = round(
                torch.cuda.get_device_properties(0).total_memory / (1024**3), 2
            )
            info["cuda_version"] = torch.version.cuda
            
        return info
    
    def measure_memory(self) -> Dict:
        """Measure current memory usage."""
        memory = {
            "ram_used_gb": round(psutil.virtual_memory().used / (1024**3), 2),
            "ram_percent": psutil.virtual_memory().percent,
        }
        
        if torch.cuda.is_available():
            memory["gpu_allocated_gb"] = round(
                torch.cuda.memory_allocated() / (1024**3), 4
            )
            memory["gpu_reserved_gb"] = round(
                torch.cuda.memory_reserved() / (1024**3), 4
            )
            
        return memory
    
    def benchmark_model_loading(
        self,
        config,
        weights_path: str,
        quantized: bool = False
    ) -> Dict:
        """Benchmark model loading time and memory."""
        print(f"\n{'='*50}")
        print(f"Benchmarking: {config.name}")
        print(f"Quantized: {quantized}")
        print(f"{'='*50}")
        
        # Clear GPU cache
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
        
        memory_before = self.measure_memory()
        
        # Time model loading
        start_time = time.time()
        
        loader = MediaAgenticLoader(config)
        model = loader.load_model(weights_path, quantized=quantized)
        
        load_time = time.time() - start_time
        memory_after = self.measure_memory()
        
        # Calculate memory delta
        ram_delta = memory_after["ram_used_gb"] - memory_before["ram_used_gb"]
        gpu_delta = 0
        if torch.cuda.is_available():
            gpu_delta = memory_after["gpu_allocated_gb"] - memory_before.get("gpu_allocated_gb", 0)
        
        results = {
            "load_time_seconds": round(load_time, 3),
            "ram_delta_gb": round(ram_delta, 4),
            "gpu_delta_gb": round(gpu_delta, 4),
            "memory_after": memory_after,
        }
        
        print(f"Load time: {load_time:.3f}s")
        print(f"RAM delta: {ram_delta:.4f} GB")
        print(f"GPU delta: {gpu_delta:.4f} GB")
        
        return results, model
    
    def benchmark_inference_speed(
        self,
        model: torch.nn.Module,
        config,
        num_runs: int = 10,
        input_shape: Tuple[int, ...] = (1, 1, 96, 96, 96)
    ) -> Dict:
        """Benchmark inference speed with synthetic data."""
        print(f"\nBenchmarking inference speed ({num_runs} runs)...")
        
        model.eval()
        
        # Create synthetic input
        dummy_input = torch.randn(*input_shape).to(self.device)
        
        # Warmup runs
        print("Warming up...")
        with torch.no_grad():
            for _ in range(3):
                _ = model(dummy_input)
        
        # Synchronize if using CUDA
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        
        # Timed runs
        times = []
        print("Running timed inference...")
        
        for i in range(num_runs):
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                
            start = time.time()
            
            with torch.no_grad():
                _ = model(dummy_input)
                
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                
            elapsed = time.time() - start
            times.append(elapsed)
            print(f"  Run {i+1}: {elapsed:.4f}s")
        
        results = {
            "num_runs": num_runs,
            "input_shape": input_shape,
            "times_seconds": times,
            "mean_time": round(np.mean(times), 4),
            "std_time": round(np.std(times), 4),
            "min_time": round(np.min(times), 4),
            "max_time": round(np.max(times), 4),
            "throughput_samples_per_sec": round(1.0 / np.mean(times), 2),
        }
        
        print(f"\nInference Results:")
        print(f"  Mean: {results['mean_time']:.4f}s ± {results['std_time']:.4f}s")
        print(f"  Min/Max: {results['min_time']:.4f}s / {results['max_time']:.4f}s")
        print(f"  Throughput: {results['throughput_samples_per_sec']:.2f} samples/sec")
        
        return results
    
    def benchmark_full_volume(
        self,
        model: torch.nn.Module,
        config,
        volume_shape: Tuple[int, ...] = (512, 512, 200)
    ) -> Dict:
        """Benchmark inference on full CT volume using sliding window."""
        print(f"\nBenchmarking full volume inference...")
        print(f"Volume shape: {volume_shape}")
        
        inference = MediaAgenticInference(model, config, self.device)
        
        # Create synthetic volume
        volume = np.random.randn(*volume_shape).astype(np.float32)
        
        # Clear GPU cache
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        
        memory_before = self.measure_memory()
        start_time = time.time()
        
        # Run inference
        segmentation = inference.predict(volume)
        
        inference_time = time.time() - start_time
        memory_after = self.measure_memory()
        
        results = {
            "volume_shape": volume_shape,
            "output_shape": segmentation.shape,
            "total_time_seconds": round(inference_time, 2),
            "voxels_per_second": round(np.prod(volume_shape) / inference_time, 0),
            "peak_gpu_memory_gb": round(
                memory_after.get("gpu_allocated_gb", 0), 4
            ),
        }
        
        print(f"Total time: {inference_time:.2f}s")
        print(f"Voxels/sec: {results['voxels_per_second']:,.0f}")
        
        return results
    
    def compare_quantization(
        self,
        config,
        original_weights: str,
        quantized_weights: str
    ) -> Dict:
        """Compare original vs quantized model performance."""
        print(f"\n{'='*60}")
        print(f"QUANTIZATION COMPARISON: {config.name}")
        print(f"{'='*60}")
        
        results = {"model_name": config.name}
        
        # Benchmark original model
        print("\n--- Original Model ---")
        orig_load, orig_model = self.benchmark_model_loading(
            config, original_weights, quantized=False
        )
        orig_inference = self.benchmark_inference_speed(orig_model, config)
        
        results["original"] = {
            "loading": orig_load,
            "inference": orig_inference,
        }
        
        # Clear memory
        del orig_model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        
        # Benchmark quantized model
        print("\n--- Quantized Model ---")
        quant_load, quant_model = self.benchmark_model_loading(
            config, quantized_weights, quantized=True
        )
        quant_inference = self.benchmark_inference_speed(quant_model, config)
        
        results["quantized"] = {
            "loading": quant_load,
            "inference": quant_inference,
        }
        
        # Calculate speedup
        speedup = orig_inference["mean_time"] / quant_inference["mean_time"]
        memory_reduction = (
            orig_load["gpu_delta_gb"] - quant_load["gpu_delta_gb"]
        ) / orig_load["gpu_delta_gb"] * 100 if orig_load["gpu_delta_gb"] > 0 else 0
        
        results["comparison"] = {
            "inference_speedup": round(speedup, 2),
            "memory_reduction_percent": round(memory_reduction, 1),
        }
        
        print(f"\n{'='*60}")
        print(f"COMPARISON SUMMARY")
        print(f"{'='*60}")
        print(f"Inference speedup: {speedup:.2f}x")
        print(f"Memory reduction: {memory_reduction:.1f}%")
        
        return results
    
    def run_full_benchmark(
        self,
        models_base_path: str,
        save_results: bool = True
    ) -> Dict:
        """Run complete benchmark suite for all models."""
        print("\n" + "="*70)
        print("MEDIA-AGENTIC-AI FULL BENCHMARK SUITE")
        print("="*70)
        
        self.results = {
            "system_info": self.get_system_info(),
            "models": {}
        }
        
        configs = [
            ("cads551", CADS551_CONFIG),
            ("cads552", CADS552_CONFIG),
        ]
        
        base_path = Path(models_base_path)
        
        for model_id, config in configs:
            original_path = base_path / model_id / "model.pth"
            quantized_path = base_path / "quantized" / f"{model_id}_int8.pth"
            
            if not original_path.exists():
                print(f"\nSkipping {model_id}: weights not found at {original_path}")
                continue
            
            model_results = {
                "config": {
                    "name": config.name,
                    "num_classes": config.num_classes,
                    "patch_size": config.patch_size,
                },
            }
            
            # Load and benchmark original
            load_results, model = self.benchmark_model_loading(
                config, str(original_path), quantized=False
            )
            model_results["loading"] = load_results
            
            # Inference benchmarks
            model_results["inference_patch"] = self.benchmark_inference_speed(
                model, config
            )
            
            # Full volume benchmark (smaller volume for speed)
            model_results["inference_volume"] = self.benchmark_full_volume(
                model, config, volume_shape=(256, 256, 100)
            )
            
            # Quantization comparison if quantized weights exist
            if quantized_path.exists():
                del model
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    
                model_results["quantization_comparison"] = self.compare_quantization(
                    config, str(original_path), str(quantized_path)
                )
            
            self.results["models"][model_id] = model_results
        
        # Save results
        if save_results:
            output_file = self.output_dir / f"benchmark_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            with open(output_file, 'w') as f:
                json.dump(self.results, f, indent=2, default=str)
            print(f"\nResults saved to: {output_file}")
        
        return self.results
    
    def generate_report(self, results: Optional[Dict] = None) -> str:
        """Generate markdown report from benchmark results."""
        results = results or self.results
        
        report = ["# MedIA-Agentic-AI Benchmark Report\n"]
        report.append(f"Generated: {datetime.now().isoformat()}\n")
        
        # System info
        report.append("## System Information\n")
        sys_info = results.get("system_info", {})
        report.append(f"- **Device**: {sys_info.get('device', 'N/A')}")
        report.append(f"- **GPU**: {sys_info.get('gpu_name', 'N/A')}")
        report.append(f"- **GPU Memory**: {sys_info.get('gpu_memory_gb', 'N/A')} GB")
        report.append(f"- **PyTorch**: {sys_info.get('pytorch_version', 'N/A')}")
        report.append("")
        
        # Model results
        report.append("## Model Benchmarks\n")
        
        for model_id, model_data in results.get("models", {}).items():
            report.append(f"### {model_id}\n")
            
            # Loading
            if "loading" in model_data:
                load = model_data["loading"]
                report.append(f"**Loading Time**: {load.get('load_time_seconds', 'N/A')}s")
                report.append(f"**GPU Memory**: {load.get('gpu_delta_gb', 'N/A')} GB\n")
            
            # Inference
            if "inference_patch" in model_data:
                inf = model_data["inference_patch"]
                report.append(f"**Inference (patch)**:")
                report.append(f"- Mean: {inf.get('mean_time', 'N/A')}s ± {inf.get('std_time', 'N/A')}s")
                report.append(f"- Throughput: {inf.get('throughput_samples_per_sec', 'N/A')} samples/sec\n")
            
            # Full volume
            if "inference_volume" in model_data:
                vol = model_data["inference_volume"]
                report.append(f"**Full Volume Inference**:")
                report.append(f"- Volume: {vol.get('volume_shape', 'N/A')}")
                report.append(f"- Time: {vol.get('total_time_seconds', 'N/A')}s")
                report.append(f"- Voxels/sec: {vol.get('voxels_per_second', 'N/A'):,}\n")
            
            report.append("")
        
        return "\n".join(report)


if __name__ == "__main__":
    # Default path for JHU server
    DEFAULT_MODELS_PATH = "/home/visitor/bodymaps_models/media_agentic"
    
    import argparse
    parser = argparse.ArgumentParser(description="Run MedIA-Agentic benchmarks")
    parser.add_argument(
        "--models-path",
        default=DEFAULT_MODELS_PATH,
        help="Path to model weights directory"
    )
    parser.add_argument(
        "--output-dir",
        default="./benchmark_results",
        help="Directory for benchmark results"
    )
    
    args = parser.parse_args()
    
    runner = BenchmarkRunner(output_dir=args.output_dir)
    results = runner.run_full_benchmark(args.models_path)
    
    # Generate and print report
    report = runner.generate_report()
    print("\n" + report)
    
    # Save report
    report_path = Path(args.output_dir) / "benchmark_report.md"
    with open(report_path, 'w') as f:
        f.write(report)
    print(f"\nReport saved to: {report_path}")