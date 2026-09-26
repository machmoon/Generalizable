# Generalizable demo data assets (orphan branch `data/assets`)

> **DEMO ONLY.** Public open-source research data, non-clinical. This branch shares no history with the app branches, so cloning or fetching `demo/addenda-and-pipeline` (including Bitrig's) never downloads it.

Every file is a tar split into parts under 95 MB (GitHub's per-file limit is 100 MB). To restore one: `./unpack.sh <name> <dest>`. It verifies the SHA-256 of the whole tar.

| Asset | Contents | Source / licence |
|---|---|---|
| `vhp_male_ct_dicom` | Visible Human Male normal CT, raw DICOM series | NLM Visible Human Project via NCI IDC `nlm_visible_human_project`; NLM Terms and Conditions (2019) |
| `body_ct_nifti` | The same volume stitched and reoriented to RAS (`body_ct.nii.gz`) | derived from the above |
| `ts_body_total`, `ts_body_body` | TotalSegmentator `total` and `body` masks for the body | derived; TotalSegmentator (Wasserthal et al. 2023), Apache-2.0 |
| `totalsegmentator_weights` | nnU-Net weights for the `total` (3 mm) and `body` (6 mm) tasks; goes in `~/.totalsegmentator/nnunet/results` | TotalSegmentator, Apache-2.0. **Excluded:** licence-restricted tasks and the per-install `config.json` |
| `head_ct_nifti`, `head_bleed_mask`, `head_ts_total`, `head_ts_body` | CQ500-CT-243 thin-slice CT (gantry-tilt corrected, RAS), its Seg-CQ500 subdural-hemorrhage mask, TotalSegmentator masks | CQ500 (Chilamkurthy et al. 2018), CC BY-NC-SA 4.0; Seg-CQ500 (Zenodo 8063221), CC BY 4.0 |

| `out_body_uncleaned`, `out_brain` | L1 bundles before label cleanup and downsampling (`data/out`); the app bundles in `App/Cases` derive from these | derived |

**Not included:** the full 2.3 GB Seg-CQ500 zip, which holds 51 cases the demo doesn't use. It's a single public download from https://zenodo.org/records/8063221, and `data/PIPELINE_LOG.md` on the demo branch records the exact case that was used.
