[Universe](https://universe.roboflow.com/ "Universe Home")

[Explore](https://universe.roboflow.com/browse)

Datasets

Models

[Trending](https://universe.roboflow.com/trending)

Sign in

[See all 364 images](https://universe.roboflow.com/joseph-nelson/bccd/browse) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0V0DvUEa8YldxooiDHvk/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/0V0DvUEa8YldxooiDHvk) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0a1kYH9LRwiUQiSxmmpF/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/0a1kYH9LRwiUQiSxmmpF) [![BCCD cells sample showing Platelets, RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0eLdBBE42VesQ08rN3UF/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/0eLdBBE42VesQ08rN3UF) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0jCQjHTIcoCt4n5CcmfT/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/0jCQjHTIcoCt4n5CcmfT) [![BCCD cells sample showing Platelets, RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1G9BOtdAqQ9TGrc3068q/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1G9BOtdAqQ9TGrc3068q) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1MWGXEaVn858tSNYefcH/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1MWGXEaVn858tSNYefcH) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1O8AFRMKFsokgH3VkwPa/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1O8AFRMKFsokgH3VkwPa) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1g5pDH9DbjZi6RCLfZf9/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1g5pDH9DbjZi6RCLfZf9) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1gBGZG8hUMcNrxPNPbMU/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1gBGZG8hUMcNrxPNPbMU) [![BCCD cells sample showing Platelets, RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1p5SiOq9SQKAoZrAoRrx/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1p5SiOq9SQKAoZrAoRrx) [![BCCD cells sample showing Platelets, RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1r8qKBgmJMCjKr9GAij0/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1r8qKBgmJMCjKr9GAij0) [![BCCD cells sample showing RBC, WBC](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/1yJCZ0Litzk8wfNDfEjl/thumb.jpg)](https://universe.roboflow.com/joseph-nelson/bccd/images/1yJCZ0Litzk8wfNDfEjl)

## About BCCD Dataset

# Overview

This is a dataset of blood cells photos, originally open sourced by [cosmicad](https://github.com/cosmicad/dataset) and [akshaylambda](https://github.com/akshaylamba/all_CELL_data).

There are 364 images across three classes: `WBC` (white blood cells), `RBC` (red blood cells), and `Platelets`. There are 4888 labels across 3 classes (and 0 null examples).

Here's a class count from Roboflow's Dataset Health Check:

![BCCD health](https://i.imgur.com/BVopW9p.png)

And here's an example image:

![Blood Cell Example](https://i.imgur.com/QwyX2aD.png)

`Fork` this dataset (upper right hand corner) to receive the raw images, or (to save space) grab the 500x500 export.

# Use Cases

This is a small scale object detection dataset, commonly used to assess model performance. It's a first example of medical imaging capabilities.

# Using this Dataset

We're releasing the data as public domain. Feel free to use it for any purpose.

It's not required to provide attribution, but it'd be nice! :)

# About Roboflow

[Roboflow](https://roboflow.ai/) makes managing, preprocessing, augmenting, and versioning datasets for computer vision seamless.

Developers reduce 50% of their boilerplate code when using Roboflow's workflow, automate annotation quality assurance, save training time, and increase model reproducibility.

#### [![Roboflow Workmark](https://i.imgur.com/WHFqYSJ.png)](https://roboflow.ai/)

Show moreShow less

## Or, Use Free Platelets, RBC and WBC Detection API

Powered by general detection model

Code

Python

```
pip install inference-sdk
```

```
# 1. Import the library
from inference_sdk import InferenceHTTPClient

# 2. Connect to your workspace
client = InferenceHTTPClient(
  api_url="https://serverless.roboflow.com",
  api_key="API****"
)

# 3. Run your workflow on an image
result = client.run_workflow(
  workspace_name="<YOUR_WORKSPACE>",
  workflow_id="<YOUR_WORKFLOW_ID>",
  images={
    "image": "YOUR_IMAGE.jpg"  # Path to your image file
  },
  parameters={
    "classes": "Platelets, RBC, WBC"
  },
  use_cache=True  # cache workflow definition for 15 minutes
)

# 4. Get your results
print(result)
```

### Run on custom image

Drop an image here or click to upload

Select classes to detect:PlateletsRBCWBC\+ custom

Or try a test image ![Example 1](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0V0DvUEa8YldxooiDHvk/thumb.jpg)![Example 2](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0a1kYH9LRwiUQiSxmmpF/thumb.jpg)![Example 3](https://source.roboflow.com/Ly2DeBzbwsemGd2ReHk4BFxy8683/0eLdBBE42VesQ08rN3UF/thumb.jpg)

If you use this dataset in a research paper, please cite it using the following BibTeX:

```
@misc{ bccd_dataset,
  title = { BCCD Dataset },
  type = { Open Source Dataset },
  author = { Roboflow },
  howpublished = { \url{ https://universe.roboflow.com/joseph-nelson/bccd } },
  url = { https://universe.roboflow.com/joseph-nelson/bccd },
  journal = { Roboflow Universe },
  publisher = { Roboflow },
  year = { 2022 },
  month = { aug },
  note = { visited on 2026-06-20 },
}
```

### Similar Projects

[See More](https://universe.roboflow.com/search?q=like:joseph-nelson%2Fbccd)

[![segmentor project thumbnail](https://source.roboflow.com/0EAfHJGXiOdbgM9451D0NVcOupS2/r4EAawSsTiBY1SZ9iJ5s/thumb.jpg)![](https://source.roboflow.com/0EAfHJGXiOdbgM9451D0NVcOupS2/r4EAawSsTiBY1SZ9iJ5s/annotation-rbc-wbc-platelets.png)](https://universe.roboflow.com/rbc-vf8v1/segmentor-wbb5a)

[**segmentor**](https://universe.roboflow.com/rbc-vf8v1/segmentor-wbb5a "segmentor Computer Vision Model")

by [RBC](https://universe.roboflow.com/rbc-vf8v1)

364·2 models

[![test2 project thumbnail](https://source.roboflow.com/2Yof3vlCVPR2kjIPblfC64UBahn2/INauaMcKXEpBivjQ6JYD/thumb.jpg)![](https://source.roboflow.com/2Yof3vlCVPR2kjIPblfC64UBahn2/INauaMcKXEpBivjQ6JYD/annotation-FRL.png)](https://universe.roboflow.com/robert-lisek/test2-bhkwt)

[**test2**](https://universe.roboflow.com/robert-lisek/test2-bhkwt "test2 Computer Vision Dataset")

by [Robert Lisek](https://universe.roboflow.com/robert-lisek)

184

[![bccd-yolov5 project thumbnail](https://source.roboflow.com/VvLewQ8ZgPUM73rgJwjwtfM8jLf2/WIU60rnzyUJ0CRRUFvSn/thumb.jpg)![](https://source.roboflow.com/VvLewQ8ZgPUM73rgJwjwtfM8jLf2/WIU60rnzyUJ0CRRUFvSn/annotation-cells.png)](https://universe.roboflow.com/csc713m/bccd-yolov5-bm7ps)

[**bccd-yolov5**](https://universe.roboflow.com/csc713m/bccd-yolov5-bm7ps "bccd-yolov5 Computer Vision Dataset")

by [CSC713M](https://universe.roboflow.com/csc713m)

364

[![123 project thumbnail](https://source.roboflow.com/IMJe1GrR8fbUX8O1cbPRqHh1wA32/t9j8ln6xCtxce2imLC3w/thumb.jpg)![](https://source.roboflow.com/IMJe1GrR8fbUX8O1cbPRqHh1wA32/t9j8ln6xCtxce2imLC3w/annotation-123.png)](https://universe.roboflow.com/project-wve0g/123-bszgu)

[**123**](https://universe.roboflow.com/project-wve0g/123-bszgu "123 Computer Vision Model")

by [Go to  projects](https://universe.roboflow.com/project-wve0g)

360·1 model

[![ABC project thumbnail](https://source.roboflow.com/MVQLRo6adnOVuxZYBgfkBQqSeyp2/yU3Qs3j3nHNZMPQ3umNO/thumb.jpg)![](https://source.roboflow.com/MVQLRo6adnOVuxZYBgfkBQqSeyp2/yU3Qs3j3nHNZMPQ3umNO/annotation-Blood-Cells.png)](https://universe.roboflow.com/bccd-dataset/abc-1bcsh)

[**ABC**](https://universe.roboflow.com/bccd-dataset/abc-1bcsh "ABC Computer Vision Dataset")

by [BCCD dataset](https://universe.roboflow.com/bccd-dataset)

364