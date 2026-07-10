"""
pitch_classifier
----------------
球種辨識模組，提供：
- PitchFeatureExtractor: 從軌跡 + 速度資料提取特徵
- RuleBasedClassifier:  基於物理規則的即時分類器（不需訓練資料）
"""

from .feature_extractor import PitchFeatureExtractor, PitchFeatures
from .rule_classifier import RuleBasedClassifier

__all__ = [
    "PitchFeatureExtractor",
    "PitchFeatures",
    "RuleBasedClassifier",
]
