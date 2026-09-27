# MedIA-Agentic-AI Model Weights

## Important Notice
**Model weights are NOT stored in this repository.**  
They must be downloaded separately to the JHU server.

## Weight Locations on JHU Server

/home/visitor/bodymaps_models/media_agentic/
├── cads551/
│   └── model.pth          # Original cads551 weights
├── cads552/
│   └── model.pth          # Original cads552 weights
└── quantized/
├── cads551_int8.pth   # Quantized cads551 (INT8)
├── cads551_fp16.pth   # Quantized cads551 (FP16)
├── cads552_int8.pth   # Quantized cads552 (INT8)
└── cads552_fp16.pth   # Quantized cads552 (FP16)

## Download Instructions

### Prerequisites
- SSH access to JHU server: `ssh visitor@bdmap1.wse.jhu.edu`
- HuggingFace CLI installed: `pip install huggingface_hub`

### Step 1: SSH into JHU Server
```bash
ssh visitor@bdmap1.wse.jhu.edu