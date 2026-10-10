package com.acme.core;

import java.util.List;
import lombok.Builder;

@Builder
public class Customer {
    private String name;
    private int age;
    private final String id;
    private final boolean active = true;
    private List<String> tags;
    private static int count;
}
